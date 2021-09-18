import EventEmitter from "node:events";
import { Worker } from "node:worker_threads";

export class Worker_ModuleCommParser extends EventEmitter {
    worker: Worker;
    constructor(worker: Worker) {
        super();
        this.worker = worker;

        this.worker.on("message", msg => {
            this.emit("message", msg);
        });
    }

    send(data: any) {
        this.worker.postMessage(data);
    }
}
