import { Worker } from "node:worker_threads";
import ModuleCommParser from "./base.js";
import type NCBCore from "..";

export class Worker_ModuleCommParser extends ModuleCommParser {
    worker: Worker;
    core: NCBCore;
    debugName: string;
    killed = false;

    constructor(worker: Worker, core: NCBCore, debugName: string) {
        super();
        this.worker = worker;
        this.core = core;
        this.debugName = debugName;

        if (!(worker instanceof Worker)) {
            throw new Error("Invalid worker");
        }

        this.worker.on("message", msg => {
            this.emit("message", msg);
            this.core.logger.debug(`${this.debugName}[comm_recv]`, msg);
        });
    }

    send(data: any) {
        if (!this.killed) {
            this.worker.postMessage(data);
            this.core.logger.debug(`${this.debugName}[comm_send]`, data);
        }
    }

    kill() {
        this.worker.terminate();
        this.killed = true;
    }
}
