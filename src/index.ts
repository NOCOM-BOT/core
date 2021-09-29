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

    profile_directory!: string;
    config: ConfigInterface = {};
    module: { [id: string]: NCBModule } = {};
    unassignedModuleID = 1;

    constructor(profile_directory: string) {
        this.profile_directory = profile_directory || process.cwd();        
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
        for (let mDir of mod) {
            this.module[(this.unassignedModuleID++).toString()] = new NCBModule(mDir);
        }
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
        } catch {}
    }
}
