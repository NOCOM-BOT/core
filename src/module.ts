import AdmZip from "adm-zip";
import path from "node:path";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";
import EventEmitter from "node:events";
import crypto from "node:crypto";
import NCBCore from "./index.js";
import ModuleCommParser from "./module_comm_parser/base.js";
import { Worker_ModuleCommParser } from "./module_comm_parser/worker.js";
import { Process_ModuleCommParser } from "./module_comm_parser/process.js";
import url from "node:url";
import fs from "node:fs/promises";
import { ChildProcess, fork } from "node:child_process";

import { loadDependencies } from "./pnpm.js";

interface HandshakeResponseFail {
    type: "handshake_fail",
    error: string | number | null
}

interface HandshakeResponseSuccess {
    type: "handshake_success",
    module: string,
    module_displayname: string,
    module_namespace: string
}

export default class NCBModule extends EventEmitter {
    core: NCBCore;

    moduleDir: string;
    moduleID: string;
    tempDataDir: string;

    zip: AdmZip;

    type: string = "unknown";
    namespace: string = "";
    communicationProtocol: string = "unknown";
    autoRestart: boolean = false;
    json: any;

    displayName: string = "";
    module: string = "unknown";

    starting = false;
    started = false;

    communicator?: ModuleCommParser;

    constructor(core: NCBCore, moduleZIPDir: string, tempDataDir: string, moduleID: string) {
        super();

        this.core = core;

        this.moduleDir = moduleZIPDir;
        this.tempDataDir = tempDataDir;
        this.moduleID = moduleID;

        this.zip = new AdmZip(this.moduleDir);
    }

    async start() {
        if (!this.starting && !this.started) {
            this.starting = true;
            // Extract module to tempDataDir
            // workaround bug cthackers/adm-zip#407
            await promisify(this.zip.extractAllToAsync)(this.tempDataDir, true, false);

            switch (this.type) {
                case "package":
                    try {
                        await this._startPackage();
                        break;
                    } catch (e) {
                        this.starting = false;
                        throw e;
                    }
                case "script":
                    try {
                        await this._startScript();
                        break;
                    } catch (e) {
                        this.starting = false;
                        throw e;
                    }
                default:
                    this.starting = false;
                    throw new Error(`Unknown module type "${this.type}"`);
            }

            this.starting = false; this.started = true;
            // process queue
            this.queueMessage(null, true);
        }
    }

    async _startPackage() {
        // Read package.json (in this.tempDataDir)
        let packageJSON = JSON.parse(await fs.readFile(path.join(this.tempDataDir, "package.json"), "utf8"));

        // Load dependencies
        await loadDependencies(this.tempDataDir);

        switch (this.communicationProtocol) {
            case "msgpack":
                throw new Error("Not implemented.");
            case "node_ipc":
                {
                    let ex = (async () => {
                        let child = fork(path.join(this.tempDataDir, packageJSON.main), [], {
                            cwd: this.tempDataDir,
                            silent: true
                        });

                        await this._handleProcess(child, ex);
                    });

                    return ex();
                }
            case "node_worker":
                throw new Error(`Protocol '${this.communicationProtocol}' is not possible in type '${this.type}'.`);
            default:
                throw new Error(`Unknown module communication protocol "${this.communicationProtocol}"`);
        }
    }

    async _startScript() {
        if (typeof this.json.scriptSrc !== "string") {
            throw new Error(`Script not found: ${this.json.scriptSrc}`);
        }

        switch (this.communicationProtocol) {
            case "msgpack":
                throw new Error("Not implemented.");
            case "node_ipc":
                {
                    let ex = (async () => {
                        let child = fork(path.join(this.tempDataDir, this.json.scriptSrc), [], {
                            cwd: this.tempDataDir,
                            silent: true
                        });

                        await this._handleProcess(child, ex);
                    });

                    return ex();
                }
            case "node_worker":
                {
                    let ex = (async () => {
                        let worker = new Worker(path.join(this.tempDataDir, this.json.scriptSrc), {
                            stderr: true,
                            stdin: false,
                            stdout: true
                        });

                        await this._handleWorker(worker, ex);
                    });

                    return ex();
                }
            default:
                throw new Error(`Unknown module communication protocol "${this.communicationProtocol}"`);
        }
    }

    async stop() {
        if (this.started && this.communicator) {
            this.communicator.kill();
            this.started = false;
        }
    }

    async readInfo() {
        // Reading information inside ZIP file (module.json)
        let jsonString = await
            promisify(this.zip.readAsTextAsync)("module.json")
                .then(e => new Error(e))
                .catch(e => e);
        if (jsonString instanceof Error) {
            throw jsonString;
        }
        let moduleObj = JSON.parse(jsonString);

        this.json = moduleObj;
        this.namespace = moduleObj.namespace;
        this.autoRestart = moduleObj.autoRestart;
        this.type = moduleObj.type;
        this.communicationProtocol = moduleObj.communicationProtocol;

        if (!(this.namespace && this.autoRestart && this.type && this.communicationProtocol)) {
            throw new Error("Missing required values in module.json");
        }
    }

    queueRunning = false;
    queueMsg: any[] = [];
    queueMessage(message: any, noPush?: boolean) {
        if (!noPush) this.queueMsg.push(message);

        if (!this.queueRunning) {
            (async () => {
                this.queueRunning = true;
                let currentMsg;

                while (currentMsg = this.queueMsg.shift()) {
                    if (!this.communicator || !this.started) {
                        this.queueMsg.unshift(currentMsg);
                        return;
                    } else {
                        this.communicator.send(currentMsg);
                    }
                }

                this.queueRunning = false;
            })();
        }
    }

    async _handshake() {
        try {
            if (this.communicator) {
                let stopTimer: Function, stopTimerFail: Function, promise = Promise.race([
                    new Promise<HandshakeResponseSuccess>(s => stopTimer = s),
                    new Promise<never>((_, c) => {
                        stopTimerFail = c;
                        setTimeout(c, 30000, {
                            type: "handshake_fail",
                            error: "Timed out (no response after 30s)."
                        });
                    })
                ]);

                function handleHandshake(data: HandshakeResponseFail | HandshakeResponseSuccess) {
                    if (typeof data === "object") {
                        if (data.type === "handshake_success") {
                            stopTimer(data);
                        } else if (data.type === "handshake_fail") {
                            stopTimerFail(data);
                        }
                    } else {
                        stopTimerFail({
                            type: "handshake_fail",
                            error: "Invalid handshake response."
                        })
                    }
                }

                this.communicator.once("message", handleHandshake);

                this.communicator.send({
                    type: "handshake",
                    id: this.moduleID,
                    protocol_version: "1"
                });

                let d = await promise;
                if (d.module_namespace === this.namespace) {
                    this.displayName = d.module_displayname;
                    this.module = d.module;
                } else {
                    throw {
                        type: "handshake_fail",
                        error: "Mismatched namespace."
                    }
                }
            } else {
                throw new Error("COMMUNICATOR NOT FOUND!!!");
            }
        } catch (e: any) {
            this.core.logger.error(`module.${this.moduleID}`, `Module ${this.moduleDir} (at ${this.tempDataDir}) failed to complete handshake:`, e?.error || e);
            throw e;
        }
    }

    async _handleCrash(crashType: string, crashRestartFunc: Function, crashError?: Error) {
        this.communicator?.kill();
        this.communicator?.removeAllListeners();
        delete this.communicator;

        if (this.autoRestart) {
            if (crashType === "timeout") {
                this.core.logger.warn(`module.${this.moduleID}`, `Module ${this.moduleDir} (at ${this.tempDataDir}) failed the challenge (not responding in 30 seconds) and is now restarting...`);
            } else if (crashType === "error") {
                this.core.logger.warn(`module.${this.moduleID}`, `Module ${this.moduleDir} (at ${this.tempDataDir}) crashed:`, crashError);
            }

            this.starting = true;
            this.started = false;
            crashRestartFunc();
        } else {
            if (crashType === "timeout") {
                this.core.logger.error(`module.${this.moduleID}`, `Module ${this.moduleDir} (at ${this.tempDataDir}) failed the challenge (not responding in 30 seconds) and has been terminated.`);
            } else if (crashType === "error") {
                this.core.logger.error(`module.${this.moduleID}`, `Module ${this.moduleDir} (at ${this.tempDataDir}) crashed:`, crashError);
            }

            this.starting = this.started = false;
        }
    }

    async _handleWorker(worker: Worker, ex: Function) {
        this.communicator = new Worker_ModuleCommParser(worker);
        worker.on("error", e => {
            this._handleCrash("error", ex, e)
        });

        this._handleData(ex);

        // Sending handshake
        return this._handshake();
    }

    async _handleProcess(process: ChildProcess, ex: Function) {
        this.communicator = new Process_ModuleCommParser(process);
        process.on("error", e => {
            this._handleCrash("error", ex, e)
        });

        this._handleData(ex);
        
        // Sending handshake
        return this._handshake();
    }

    async _createChallenge() {
        if (this.communicator) {
            let challenge = crypto.randomBytes(128).toString("base64");
            let stopTimer: Function, promise = Promise.race([
                new Promise<void>(s => stopTimer = s),
                new Promise<never>((_, c) => setTimeout(c, 30000))
            ]);

            function handleChallenge(data: {
                type: "challenge_response",
                challenge: string
            }) {
                if (
                    typeof data === "object" &&
                    data.type === "challenge_response" &&
                    data.challenge === challenge
                ) {
                    stopTimer();
                }
            }

            this.communicator.on("message", handleChallenge);

            this.communicator.send({
                type: "challenge",
                challenge
            });

            try {
                await promise;
            } catch {
                throw new Error("Challenge timeout");
            }

            this.communicator.removeListener("message", handleChallenge);
        }
    }

    _handleData(restartFunc: Function) {
        if (this.communicator) {
            let abortChallengeClock = new AbortController();
            (async () => {
                for (; ;) {
                    // Issuing a new challenge every 30-60s
                    await new Promise(r => setTimeout(r, Math.round(Math.random() * 30000) + 30000));
                    if (!abortChallengeClock.signal.aborted && this.communicator) {
                        try {
                            await this._createChallenge();
                        } catch {
                            abortChallengeClock.abort();
                            this._handleCrash("timeout", restartFunc);
                        }
                    }
                }
            })();

            this.communicator.on("message", data => {
                if (typeof data === "object") {
                    switch (data.type) {
                        case "api_send":
                            this.core.module[data.call_to]?.queueMessage({
                                type: "api_call",
                                call_from: this.moduleID,
                                call_cmd: data.call_cmd,
                                data: data.data,
                                nonce: data.nonce
                            });
                            break;
                        case "api_sendresponse":
                            this.core.module[data.response_to]?.queueMessage({
                                type: "api_response",
                                response_from: this.moduleID,
                                exist: data.exist,
                                data: data.data,
                                error: data.error,
                                nonce: data.nonce
                            });
                            break;
                    }
                }

                this.emit("message", data);
            });
        }
    }
}
