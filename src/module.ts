import AdmZip from "adm-zip";
import path from "node:path";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";
import EventEmitter from "node:events";
import crypto from "node:crypto";
import NCBCore from ".";
import ModuleCommParser from "./module_comm_parser/base";
import { Worker_ModuleCommParser } from "./module_comm_parser/worker";

export default class NCBModule extends EventEmitter {
    core: NCBCore;

    moduleDir: string;
    moduleID: string;
    tempDataDir: string;

    zip: AdmZip;

    type: string = "unknown";
    shortName: string = "";
    communicationProtocol: string = "unknown";
    autoRestart: boolean = false;
    json: any;

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
            await promisify(this.zip.extractAllToAsync)(this.tempDataDir, true);

            switch (this.type) {
                case "package":
                    this.starting = false;
                    throw new Error("Not implemented.");
                case "script":
                    try {
                        await this.startScript();
                        this.starting = false;
                        this.started = true;
                        this.queueMessage(null, true);
                        return;
                    } catch (e) {
                        this.starting = false;
                        this.started = false;
                        throw e;
                    }
                default:
                    this.starting = false; throw new Error(`Unknown module type "${this.type}"`);
            }
        }
    }

    async startScript() {
        switch (this.communicationProtocol) {
            case "msgpack":
                throw new Error("This protocol is not possible in current configuration.");
            case "node_ipc":
                throw new Error("Not implemented.");
            case "node_worker":
                {
                    if (typeof this.json.scriptSrc !== "string") {
                        throw new Error(`Script not found: ${this.json.scriptSrc}`);
                    }

                    let ex = (async () => {
                        let worker = new Worker(path.join(this.tempDataDir, this.json.scriptSrc), {
                            stderr: false,
                            stdin: false,
                            stdout: false
                        });

                        worker.on("error", e => {
                            if (this.autoRestart) {
                                this.core.logger.warn(`Module ID ${this.moduleID} = ${this.moduleDir} (at ${this.tempDataDir}) crashed:`, e);
                                worker.terminate();
                                ex();
                            } else {
                                this.core.logger.error(`Module ID ${this.moduleID} = ${this.moduleDir} (at ${this.tempDataDir}) crashed:`, e);
                                worker.terminate();
                            }
                        });
                        this.communicator = new Worker_ModuleCommParser(worker);

                        let lastChallengeCode = "";
                        let chal = setInterval(() => {
                            if (lastChallengeCode === "") {
                                lastChallengeCode = crypto.randomBytes(128).toString("base64");
                                if (this.communicator) {
                                    this.communicator.send({
                                        type: "challenge",
                                        challenge: lastChallengeCode
                                    });
                                }
                            } else {
                                // Challenge failed: not responding in 30 seconds.
                                clearInterval(chal);
                                if (this.autoRestart) {
                                    this.core.logger.warn(`Module ID ${this.moduleID} = ${this.moduleDir} (at ${this.tempDataDir}) failed the challenge (not responding in 30 seconds) and is now restarting...`);
                                    worker.terminate();
                                    ex();
                                } else {
                                    this.core.logger.error(`Module ID ${this.moduleID} = ${this.moduleDir} (at ${this.tempDataDir}) failed the challenge (not responding in 30 seconds) and has been terminated.`);
                                    worker.terminate();
                                }
                            }
                        }, 30000);


                        let rh: Function, rjh: Function, handshakePromise = new Promise((r, rj) => { rh = r; rjh = rj });
                        this.communicator.on("message", data => {
                            if (typeof data === "object") {
                                switch (data.type) {
                                    case "handshake_success":
                                        return rh(data);
                                    case "handshake_fail":
                                        return rjh(data);
                                    case "challenge_response":
                                        if (data.challenge === lastChallengeCode) {
                                            lastChallengeCode = "";
                                        }
                                        break;
                                    case "api_send":
                                        this.core.module[data.call_to].queueMessage({
                                            type: "api_call",
                                            call_from: this.moduleID,
                                            call_cmd: data.call_cmd,
                                            data: data.data,
                                            nonce: data.nonce
                                        });
                                        break;
                                    case "api_sendresponse":
                                        this.core.module[data.response_to].queueMessage({
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

                        // Sending handshake
                        this.communicator.send({
                            type: "handshake",
                            id: this.moduleID,
                            protocol_version: "1"
                        });

                        await Promise.race([
                            handshakePromise,
                            new Promise((_, r) => {
                                setTimeout(r, 30000, "Module didn't respond to handshake in 30 seconds.")
                            })
                        ]);
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
        let jsonString = await promisify(this.zip.readAsTextAsync)("module.json");
        let moduleObj = JSON.parse(jsonString);

        this.json = moduleObj;
        this.shortName = moduleObj.shortName;
        this.autoRestart = moduleObj.autoRestart;
        this.type = moduleObj.type;
        this.communicationProtocol = moduleObj.communicationProtocol;

        if (!(this.shortName && this.autoRestart && this.type && this.communicationProtocol)) {
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
}
