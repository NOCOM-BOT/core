import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { ConfigInterface } from "./interface";
import NCBModule from "./module";

const defaultCfg = {};

export default class NCBCore {
    runInstanceID = "00000000000000000000000000000000";

    starting = false;
    running = false;

    logger;
    profile_directory!: string;
    config: ConfigInterface = {};
    module: { [id: string]: NCBModule } = {};
    unassignedModuleID = 1;

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

    async loadConfig() {
        let cfg = JSON.parse(await fs.readFile(path.join(this.profile_directory, "config.json"), { encoding: "utf8" }));
        this.config = await this.applyDefault(cfg, defaultCfg);
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
                    path.join(this.profile_directory, "temp", this.runInstanceID, `plugin-${assignedID}`),
                    assignedID.toString()
                );
            c.push(m);

            try {
                await m.readInfo();
            } catch (e) {
                this.logger.error(`An error occurred while trying to assign module ID ${assignedID} = ${mDir}:`, e);
            }
        }

        await Promise.allSettled(c.map(async x => {
            try {
                await x.start();
            } catch (e) {
                this.logger.error(
                    `An error occurred while trying to start module ID ${
                        x.moduleID
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
