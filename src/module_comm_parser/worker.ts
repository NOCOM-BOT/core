import { Worker } from "node:worker_threads";
import ModuleCommParser from "./base";

export class Worker_ModuleCommParser extends ModuleCommParser {
    worker: Worker;
    killed = false;

    constructor(worker: Worker) {
        super();
        this.worker = worker;

        this.worker.on("message", msg => {
            this.emit("message", msg);
        });
    }

    send(data: any) {
        if (!this.killed)
            this.worker.postMessage(data);
    }

    kill() {
        this.worker.terminate();
        this.killed = true;
    }
}
