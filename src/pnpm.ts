import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

import { ChildProcess, fork } from 'node:child_process';

class PNPMError extends Error {
    stderr: string;
    stdout: string;

    constructor(error: string, stderr: string, stdout: string) {
        super(error);
        this.stderr = stderr;
        this.stdout = stdout;
    }
}

let pnpmLocation = "";
if (existsSync(join(__dirname, "..", "..", "node_modules", "pnpm", "bin", "pnpm.cjs"))) {
    pnpmLocation = join(__dirname, "..", "..", "node_modules", "pnpm", "bin", "pnpm.cjs");
} else {
    throw new Error("Could not find PNPM (dependency of the kernel).");
}

export function loadDependencies(cwd: string) {
    return new Promise<void>((resolve, reject) => {
        let pnpm: ChildProcess;
        pnpm = fork(pnpmLocation, ["install", "--prefer-offline", "--frozen-lockfile"], { cwd, stdio: ["ignore", "pipe", "pipe", "ipc"] });

        let stderr: Buffer[] = [];
        let stdout: Buffer[] = [];
        pnpm.stderr?.on?.("data", d => stderr.push(d));
        pnpm.stdout?.on?.("data", d => stdout.push(d));

        pnpm.on("error", reject);
        pnpm.on("exit", (code) => {
            if (code !== 0) {
                let stderrArray = new Uint8Array(stderr.reduce((a, b) => a + b.length, 0));
                let stdoutArray = new Uint8Array(stdout.reduce((a, b) => a + b.length, 0));
                // Copy the buffers into the new array
                let currPos = 0;
                for (let buffer of stderr) {
                    stderrArray.set(new Uint8Array(buffer), currPos);
                    currPos += buffer.length;
                }
                currPos = 0;
                for (let buffer of stdout) {
                    stdoutArray.set(new Uint8Array(buffer), currPos);
                    currPos += buffer.length;
                }

                // Convert array to Node.JS buffer and to UTF-8 string
                let stderrString = Buffer.from(stderrArray).toString("utf8");
                let stdoutString = Buffer.from(stdoutArray).toString("utf8");

                reject(new PNPMError(`PNPM exited with code ${code}`, stderrString, stdoutString));
            } else {
                resolve();
            }
        });
    });
}

export function loadSpecificDependencies(cwd: string, dep: string) {
    return new Promise<void>((resolve, reject) => {
        let pnpm: ChildProcess;
        pnpm = fork(pnpmLocation, ["add", dep], { cwd, silent: true });

        let stderr: Buffer[] = [];
        let stdout: Buffer[] = [];
        pnpm.stderr?.on?.("data", d => stderr.push(d));
        pnpm.stdout?.on?.("data", d => stdout.push(d));

        pnpm.on("error", reject);
        pnpm.on("exit", (code) => {
            if (code !== 0) {
                let stderrArray = new Uint8Array(stderr.reduce((a, b) => a + b.length, 0));
                let stdoutArray = new Uint8Array(stdout.reduce((a, b) => a + b.length, 0));
                // Copy the buffers into the new array
                let currPos = 0;
                for (let buffer of stderr) {
                    stderrArray.set(new Uint8Array(buffer), currPos);
                    currPos += buffer.length;
                }
                currPos = 0;
                for (let buffer of stdout) {
                    stdoutArray.set(new Uint8Array(buffer), currPos);
                    currPos += buffer.length;
                }

                // Convert array to Node.JS buffer and to UTF-8 string
                let stderrString = Buffer.from(stderrArray).toString("utf8");
                let stdoutString = Buffer.from(stdoutArray).toString("utf8");

                reject(new PNPMError(`PNPM exited with code ${code}`, stderrString, stdoutString));
            } else {
                resolve();
            }
        });
    });
}
