import { ChildProcessWithoutNullStreams } from "node:child_process";
import ModuleCommParser from "./base.js";
import msgpack5 from "msgpack5";
import { promisify } from "node:util";

const msgpack = msgpack5();

export class STDIO_ModuleCommParser extends ModuleCommParser {
    process: ChildProcessWithoutNullStreams;
    killed = false;
    msgReading = 0;
    msgLength: number[] = [];
    msgLengthFinal = -1;
    msgBuffer: number[] = [];

    constructor(process: ChildProcessWithoutNullStreams) {
        super();
        this.process = process;

        this.process.stdout.on("data", d => {
            let buf = Buffer.from(d, "ascii");

            for (let byte = 0; byte < buf.length; byte++) {
                if (this.msgReading == 4) {
                    if (this.msgLengthFinal >= 0) {
                        if (this.msgBuffer.length < this.msgLengthFinal) {
                            this.msgBuffer.push(buf[byte]);
                            if (this.msgBuffer.length === this.msgLengthFinal) {
                                this.msgLengthFinal = -1;
                                this.emit("message", msgpack.decode(Buffer.from(this.msgBuffer)));
                                this.msgBuffer = [];
                                this.msgReading = 0;
                            }
                            continue;
                        } else {
                            this.msgLengthFinal = -1;
                            this.emit("message", msgpack.decode(Buffer.from(this.msgBuffer)));
                            this.msgBuffer = [];
                            this.msgReading = 0;
                        }
                    }

                    if (this.msgLength.length < 4) {
                        this.msgLength.push(buf[byte]);
                        if (this.msgLength.length === 4) {
                            // INEFFICIENT! lol
                            this.msgLengthFinal = parseInt(`0x${this.msgLength.map(x => x.toString(16).padStart(2, "0")).join("")
                                }`, 16);
                        }
                        continue;
                    }
                }

                if (buf[byte] == 0x41) {
                    if (this.msgReading < 4) {
                        this.msgReading++
                    }
                }
            }
        });
    }

    send(data: any) {
        if (!this.killed)
            this.queueMessage(msgpack.encode(data) as any as Buffer);
    }

    kill() {
        this.process.kill("SIGTERM");
        this.killed = true;
    }

    queue: Buffer[] = [];
    queueRunning = false;
    queueMessage(buffer?: Buffer) {
        if (buffer) {
            this.queue.push(buffer);
        }

        if (!this.queueRunning) {
            (async () => {
                this.queueRunning = true;

                let msg: Buffer | undefined;
                while (msg = this.queue.shift()) {
                    if (msg) {
                        let p = promisify(this.process.stdin.write.bind(this.process.stdin)) as any as (buf: Buffer) => Promise<void>;

                        await p(msg);
                    }
                }

                this.queueRunning = false;
            })();
        }
    }
}
