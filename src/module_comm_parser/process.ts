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

    async kill() {
        let res = this.process.kill("SIGTERM");
        if (!res) {
            this.process.kill("SIGKILL");
        } else {
            // wait for process to exit
            try {
                await Promise.race([
                    new Promise<void>(resolve => {
                        this.process.on("exit", () => {
                            resolve();
                        });
                    }),
                    new Promise<void>((_, reject) => {
                        setTimeout(() => {
                            reject();
                        }, 10000);
                    })
                ]);
            } catch {
                this.process.kill("SIGKILL");
            }
        }
        this.killed = true;
    }
}
