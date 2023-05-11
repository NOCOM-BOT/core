import { ChildProcess } from "node:child_process";
import ModuleCommParser from "./base.js";

export class Process_ModuleCommParser extends ModuleCommParser {
    process: ChildProcess;
    killed = false;

    constructor(process: ChildProcess) {
        super();
        this.process = process;

        this.process.on("message", message => {
            this.emit("message", message);
        });
    }

    send(data: any) {
        if (!this.killed) {
            this.process.send(data);
            this.emit("message_send", data);
        }
    }

    kill() {
        this.process.kill("SIGTERM");
        this.killed = true;
    }
}
