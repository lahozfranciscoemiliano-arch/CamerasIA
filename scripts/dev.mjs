// Arranca backend (tsx watch) y frontend (vite) en paralelo para desarrollo.
import { spawn } from "node:child_process";

const procs = [
  spawn("npm", ["run", "dev", "-w", "server"], { stdio: "inherit", shell: process.platform === "win32" }),
  spawn("npm", ["run", "dev", "-w", "web"], { stdio: "inherit", shell: process.platform === "win32" }),
];

const stop = () => procs.forEach((p) => p.kill("SIGTERM"));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
procs.forEach((p) => p.on("exit", (code) => { if (code) { stop(); process.exit(code); } }));
