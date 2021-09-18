import EventEmitter from "node:events";
import { ChildProcess } from "node:child_process";

export class Process_ModuleCommParser extends EventEmitter {
    process: ChildProcess;
    constructor(process: ChildProcess) {
        super();
        this.process = process;

        this.process.on("message", message => {
            this.emit("message", message);
        });
    }

    send(data: any) {
        this.process.send(data);
    }
}
