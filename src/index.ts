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
    crashOnDefaultDatabaseFail: true,
    moduleConfig: {},
    operators: []
};

class SignalChannel extends EventEmitter { }
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
        let callback: (rt: string | boolean) => void = () => { };
        let promise = new Promise<string | boolean>(r => callback = r);

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
    config: ConfigInterface = defaultCfg;
    module: {
        core: NCBCoreModule,
        [id: string]: NCBCoreModule | NCBModule
    } = {
            core: new NCBCoreModule(this)
        };
    unassignedModuleID = 1;
    tempData: {
        [key: string]: any,
        plReg: {
            [namespace: string]: {
                pluginName: string,
                version: string,
                author: string,
                resolver: string
            }
        },
        defaultDatabase: number,
        databases: Map<number, string>,
        persistentData: Map<NCBModule, any>
    } = {
            plReg: {},
            defaultDatabase: NaN,
            databases: new Map(),
            persistentData: new Map()
        };
    promptChannel = new PromptChannel();
    signalChannel = new SignalChannel();

    constructor(profile_directory: string, logger: {
        verbose: (...data: any) => void,
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
            await this.initializeDatabaseModules();
            await this.initializePluginHandlers();
            this.initializeInterfaceListener();
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
            await fs.mkdir(path.join(this.profile_directory), { recursive: true });
            await fs.mkdir(path.join(this.profile_directory, "plugins"), { recursive: true });
        } catch { }
    }

    async loadConfig() {
        try {
            let cfg = JSON.parse(await fs.readFile(path.join(this.profile_directory, "config.json"), { encoding: "utf8" }));
            this.config = await this.applyDefault(cfg, defaultCfg);
        } catch (e) {
            this.logger.warn("core", "Config file not found or is broken, using default config:", e);
            this.config = defaultCfg;
        }
        await fs.writeFile(path.join(this.profile_directory, "config.json"), JSON.stringify(this.config, null, "\t"));
    }

    async applyDefault(config: ConfigInterface, defaultConfig: ConfigInterface) {
        return {
            ...defaultConfig,
            ...config
        }
    }

    async scanModules() {
        this.logger.info("core", `Searching for modules...`);
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
                x.setConfig(this.config.moduleConfig[x.namespace]);
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

    async initializeDatabaseModules() {
        for (let databaseCfg of this.config.databases) {
            let m = Object.values(this.module).find(m => m.namespace === databaseCfg.shortName);
            if (m) {
                if (m.module === "database" && m instanceof NCBModule) {
                    if (!this.tempData.databases.has(databaseCfg.id)) {
                        this.logger.info("core", `Initializing database ID ${databaseCfg.id} in module ${m.moduleID} (${m.displayName})`);
                        let data = await this.module.core.callAPI(m.moduleID, "connect_db", {
                            databaseID: databaseCfg.id,
                            params: databaseCfg.params
                        });
                        if (data.exist) {
                            if (data.data && data.data.success) {
                                this.logger.info("core", `Database ID ${databaseCfg.id} initialized.`);
                                this.tempData.databases.set(databaseCfg.id, m.moduleID);
                            } else {
                                this.logger.error("core", `Cannot initialize database ID ${databaseCfg.id}:`, data.error);
                            }
                        } else {
                            this.logger.error("core", `Cannot initialize database ID ${databaseCfg.id}: Specified module handler (${databaseCfg.shortName}) is not spec-compliant.`);
                        }
                    } else {
                        this.logger.warn("core", `Database ID ${databaseCfg.id} already initialized, skipping...`);
                    }
                } else {
                    this.logger.error("core", `Cannot initialize database ID ${databaseCfg.id}: Specified module handler (${databaseCfg.shortName}) is not a database handler.`);
                }
            } else {
                this.logger.error("core", `Cannot initialize database ID ${databaseCfg.id}: Specified module handler (${databaseCfg.shortName}) does not exist.`);
            }
        }

        // Test for default database
        if (!this.tempData.databases.has(Number(this.config.defaultDatabase))) {
            if (this.config.crashOnDefaultDatabaseFail) {
                this.logger.critical("core", `Default database cannot be initialized.`);
                throw new Error("Default database initialization failed.");
            } else {
                this.logger.warn("core", `Default database cannot be initialized, selecting lowest ID database as default...`);
                let lowestID = [...this.tempData.databases.keys()].sort((a, b) => a - b)[0];
                if (lowestID) {
                    this.logger.info("core", `Selected default database is ${lowestID}.`);
                    this.tempData.defaultDatabase = lowestID;
                } else {
                    this.logger.critical("core", `No database detected. Please check your config and add a database.`);
                    throw new Error("Default database initialization failed.");
                }
            }
        } else {
            this.tempData.defaultDatabase = Number(this.config.defaultDatabase);
            this.logger.info("core", `Selected default database is ${Number(this.config.defaultDatabase)}.`);
        }
    }

    async initializePluginHandlers() {
        this.logger.info("core", `Searching for plugins...`);
        let result: { moduleID: string, path: string }[] = [];

        for (let moduleID in this.module) {
            if (this.module[moduleID].module !== "pl_handler") {
                continue;
            }

            let findResult = await this.module.core.callAPI(moduleID, "plugin_search", {
                pathname: path.join(this.profile_directory, "plugins")
            });

            if (findResult.exist) {
                if (typeof findResult.data === "object" && Array.isArray(findResult.data.valid)) {
                    let arr = findResult.data.valid as string[];
                    this.logger.info("core", `Plugin handler at ID ${moduleID} (${this.module[moduleID].displayName}) found ${arr.length} plugin(s).`);
                    result = result.concat(arr.map(x => ({
                        moduleID: moduleID,
                        path: x
                    })));
                } else {
                    this.logger.error("core", `Plugin handler at ID ${moduleID} (${this.module[moduleID].displayName}) throw an error:`, findResult.error);
                }
            } else {
                continue;
            }
        }

        this.logger.info("core", `${result.length} plugin(s) found.`);

        let pArray: Promise<boolean>[] = [];
        for (let { moduleID, path } of result) {
            let m = this.module[moduleID];
            if (m instanceof NCBModule) {
                pArray.push((async () => {
                    this.logger.info("core", `Initializing plugin at ${path} (handler: ${m.displayName})`);

                    // Test if path is a file or directory
                    let stat = await fs.stat(path);
                    let callObj: { filename?: string, pathname?: string } = {};
                    if (stat.isFile()) {
                        callObj.filename = path;
                    } else {
                        callObj.pathname = path;
                    }

                    let data = await this.module.core.callAPI(moduleID, "load_plugin", callObj);
                    if (data.exist) {
                        if (data.data && data.data.loaded) {
                            this.logger.info("core", `Handler ID ${moduleID} (${m.displayName}) initialized plugin ${data.data.pluginName} v${data.data.version} by ${data.data.author} (namespace ${data.data.namespace}).`);
                            return true;
                        } else {
                            this.logger.error("core", `Cannot initialize plugin at ${path} handled by ID ${moduleID}:`, data.data.error ?? data.error);
                            return false;
                        }
                    } else {
                        this.logger.error("core", `Cannot initialize plugin handled by ID ${moduleID}: Specified module handler (${m.displayName}) is not spec-compliant.`);
                        return false;
                    }
                })());
            } else {
                this.logger.error("core", `Cannot initialize plugin handled by ID ${moduleID}: Specified module handler (${m.displayName}) is not a plugin handler.`);
            }
        }

        let loadResult = await Promise.all(pArray);
        this.logger.info("core", `${loadResult.filter(x => x).length} plugin(s) initialized.`);
    }

    async initializeInterfaceListener() {
        for (let interfaceCfg of this.config.listener) {
            let m = Object.values(this.module).find(m => m.namespace === interfaceCfg.shortName);
            if (m) {
                if (m.module === "interface" && m instanceof NCBModule) {
                    this.logger.info("core", `Initializing interface ID ${interfaceCfg.id} in module ${m.moduleID} (${m.displayName})`);
                    let data = await this.module.core.callAPI(m.moduleID, "login", {
                        interfaceID: interfaceCfg.id,
                        loginData: interfaceCfg.loginData
                    });

                    if (data.exist) {
                        if (data.data && data.data.success) {
                            this.logger.info("core", `Interface ID ${interfaceCfg.id} initialized.`);
                        } else {
                            this.logger.error("core", `Cannot initialize interface ID ${interfaceCfg.id}:`, data.error);
                        }
                    } else {
                        this.logger.error("core", `Cannot initialize interface ID ${interfaceCfg.id}: Specified module handler (${interfaceCfg.shortName}) is not spec-compliant.`);
                    }
                } else {
                    this.logger.error("core", `Cannot initialize interface ID ${interfaceCfg.id}: Specified module handler (${interfaceCfg.shortName}) is not a interface handler.`);
                }
            } else {
                this.logger.error("core", `Cannot initialize interface ID ${interfaceCfg.id}: Specified module handler (${interfaceCfg.shortName}) does not exist.`);
            }
        }
    }
}
