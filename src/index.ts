import fs from "node:fs/promises";
import path from "node:path";
import { ConfigInterface } from "./interface";
import NCBModule from "./module";

const defaultCfg = {};

export default class NCBCore {
    starting = false;
    running = false;

    profile_directory!: string;
    config: ConfigInterface = {};
    module: NCBModule[] = [];

    constructor(profile_directory: string) {
        this.profile_directory = profile_directory || process.cwd();
    }

    async start() {
        if (!this.starting && !this.running) {
            this.starting = true;
            await this.loadConfig();

            await this.initializeModules();
            this.starting = false;
            this.running = true;
        }
    }

    async stop() {
        if (this.running) {
            await this.killModules();

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

    async initializeModules() {
        
    }

    async killModules() {

    }
}
