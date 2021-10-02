import AdmZip from "adm-zip";
import { promisify } from "node:util";
import worker from "node:worker_threads";
import NCBCore from ".";
import ModuleCommParser from "./module_comm_parser/base";

export default class NCBModule {
    core: NCBCore;

    moduleDir: string;
    moduleID: string;
    tempDataDir: string;

    zip: AdmZip;

    type: string = "unknown";
    shortName: string = "";
    communicationProtocol: string = "unknown";
    autoRestart: boolean = false;

    starting = false;
    started = false;

    communicator?: ModuleCommParser;

    constructor(core: NCBCore, moduleZIPDir: string, tempDataDir: string, moduleID: string) {
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
                        return;
                    } catch (e) {
                        this.starting = false;
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
            case "node_worker":
            case "node_ipc":
                throw new Error("Not implemented.");
            default:
                throw new Error(`Unknown module communication protocol "${this.communicationProtocol}"`);
        }
    }

    async stop() {

    }

    async readInfo() {
        // Reading information inside ZIP file (module.json)
        let jsonString = await promisify(this.zip.readAsTextAsync)("module.json");
        let moduleObj = JSON.parse(jsonString);

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
                    if (!this.communicator) {
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
