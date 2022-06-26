import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

import { ChildProcess, fork } from 'node:child_process';

let pnpmLocation = "";
if (existsSync(join(__dirname, "..", "..", "node_modules", "pnpm", "bin", "pnpm.cjs"))) {
    pnpmLocation = join(__dirname, "..", "..", "node_modules", "pnpm", "bin", "pnpm.cjs");
} else {
    throw new Error("Could not find PNPM (dependency of the kernel).");
}

export async function loadDependencies(cwd: string) {
    let pnpm: ChildProcess;
    pnpm = fork(pnpmLocation, ["install"], { cwd, silent: true });

    return new Promise<void>((resolve, reject) => {
        pnpm.on("error", reject);
        pnpm.on("exit", (code) => {
            if (code !== 0) {
                reject(new Error(`PNPM exited with code ${code}`));
            } else {
                resolve();
            }
        });
    });
}
