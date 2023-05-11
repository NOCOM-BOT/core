import { Worker } from "node:worker_threads";
import ModuleCommParser from "./base.js";

export class Worker_ModuleCommParser extends ModuleCommParser {
    worker: Worker;
    killed = false;

    constructor(worker: Worker) {
        super();
        this.worker = worker;

        if (!(worker instanceof Worker)) {
            throw new Error("Invalid worker");
        }

        this.worker.on("message", msg => {
            this.emit("message", msg);
        });
    }

    send(data: any) {
        if (!this.killed) {
            this.emit("message_send", data);
            this.worker.postMessage(data);
        }
    }

    async kill() {
        await this.worker.terminate();
        this.killed = true;
    }
}
