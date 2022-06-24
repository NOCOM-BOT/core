import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ConfigInterface } from "./interface.js";
import NCBModule from "./module.js";
import NCBCoreModule from "./core_module.js";
import EventEmitter from "node:events";

import packageJSON from "../package.json" assert { type: "json" };

const defaultCfg: ConfigInterface = {
    listener: [],
    databases: [],
    defaultDatabase: 0,
    moduleConfig: {}
};

class SignalChannel extends EventEmitter {}
class PromptChannel extends EventEmitter {
    promptList: {
        [nonceID: string]: {
            promptInfo: string,
            promptType: "string" | "yes-no",
            defaultValue?: string | boolean,
            callback: Function
        }
    } = {}

    reset() {
        this.promptList = {};
    }

    async prompt(type: "string" | "yes-no", promptInfo: string, defaultValue?: string | boolean) {
        // Generate random nonce ID
        let nonceID = crypto.randomBytes(64).toString("hex");
        let callback: (rt: string | boolean) => void = () => {};
        let promise = new Promise<string|boolean>(r => callback = r);

        this.promptList[nonceID] = {
            promptInfo,
            promptType: type,
            defaultValue,
            callback
        }

        this.emit("prompt", nonceID);

        return promise.then(v => {
            delete this.promptList[nonceID];
            return v;
        });
    }
}

export default class NCBCore {
    static kernelVersion = packageJSON.version;

    runInstanceID = "00000000000000000000000000000000";

    starting = false;
    running = false;

    logger;
    profile_directory!: string;
    config: ConfigInterface = {};
    module: {
        [id: string]: NCBCoreModule | NCBModule
    } = {};
    unassignedModuleID = 1;
    tempData: {
        [key: string]: any,
        plReg: {
            [namespace: string]: {
                pluginName: string,
                version: string,
                author: string
            }
        }
    } = {
        plReg: {}
    };
    promptChannel = new PromptChannel();
    signalChannel = new SignalChannel();

    constructor(profile_directory: string, logger: {
        debug: (...data: any) => void,
        info: (...data: any) => void,
        warn: (...data: any) => void,
        error: (...data: any) => void,
        critical: (...data: any) => void
    }) {
        this.profile_directory = profile_directory || process.cwd();
        this.logger = logger;
    }

    async start() {
        if (!this.starting && !this.running) {
            this.starting = true;
            this.runInstanceID = crypto.randomBytes(16).toString("hex");
            await this.ensureProfileDir();
            await this.loadConfig();
            await this.createTemp();

            await this.initializeModules();
            this.starting = false;
            this.running = true;
        }
    }

    async stop() {
        if (this.running && !this.starting) {
            await this.killModules();
            await this.clearTemp();

            this.running = false;
        }
    }

    async ensureProfileDir() {
        try {
            await fs.mkdir(path.join(this.profile_directory, "temp", this.runInstanceID), { recursive: true });
        } catch { }
    }

    async loadConfig() {
        try {
            let cfg = JSON.parse(await fs.readFile(path.join(this.profile_directory, "config.json"), { encoding: "utf8" }));
            this.config = await this.applyDefault(cfg, defaultCfg);
        } catch {
            this.config = await this.applyDefault({}, defaultCfg);
            await fs.writeFile(path.join(this.profile_directory, "config.json"), JSON.stringify(this.config, null, "\t"));
        }
    }

    async applyDefault(config: ConfigInterface, defaultConfig: ConfigInterface) {
        return {
            ...defaultConfig,
            ...config
        }
    }

    async scanModules() {
        try {
            let b = path.join(this.profile_directory, "modules");
            if (!fsSync.existsSync(b)) {
                await fs.mkdir(b, { recursive: true });
            }
            let dir = await fs.readdir(b, { withFileTypes: true, encoding: "utf8" });
            return dir.filter(f => f.isFile() && path.parse(f.name).ext === ".zip").map(f => path.join(b, f.name));
        } catch {
            return [];
        }
    }

    async initializeModules() {
        this.module.core = new NCBCoreModule(this);

        let mod = await this.scanModules();
        let c = [];
        for (let mDir of mod) {
            let assignedID = this.unassignedModuleID++;

            let m = this.module[assignedID.toString()] =
                new NCBModule(
                    this,
                    mDir,
                    path.join(this.profile_directory, "temp", this.runInstanceID, `tmodule-${assignedID}`),
                    assignedID.toString()
                );
            c.push(m);

            try {
                await m.readInfo();
            } catch (e) {
                this.logger.error("core", `An error occurred while trying to assign module ID ${assignedID} = ${mDir}:`, e);
                c.pop();
                delete this.module[assignedID.toString()];
            }
        }

        return Promise.allSettled(c.map(async x => {
            try {
                await x.start();
                this.signalChannel.emit("plugin_load", {
                    id: x.moduleID,
                    namespace: x.namespace
                });
                this.logger.info(`core[${x.namespace}]`, `Module ${x.moduleID} (${x.displayName}) loaded.`);
            } catch (e) {
                this.logger.error(
                    "core",
                    `An error occurred while trying to start module ID ${x.moduleID
                    } = ${x.moduleDir} (at ${x.tempDataDir}):`,
                    e
                );
                throw e;
            }
        }));
    }

    async killModules() {
        await Promise.all(Object.values(this.module).map(m => m.stop()));
        for (let mID in this.module) {
            delete this.module[mID];
        }
    }

    async createTemp() {
        try {
            await fs.mkdir(path.join(this.profile_directory, "temp", this.runInstanceID), { recursive: true });
        } catch (e) {
            let ex = e as any as Error;
            throw new Error("Cannot create temp folder. You should try restart first, then file a bug if the error presist.\n" + ex?.stack ?? e);
        }
    }

    async clearTemp() {
        try {
            await fs.rm(path.join(this.profile_directory, "temp", this.runInstanceID), { recursive: true });
        } catch { }
    }
}
