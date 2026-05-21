import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import path from "node:path";

const cwd = process.cwd();

function start(name, args) {
  const out = openSync(path.join(cwd, `${name}.log`), "a");
  const err = openSync(path.join(cwd, `${name}.err.log`), "a");
  const child = spawn(process.execPath, args, {
    cwd,
    detached: true,
    stdio: ["ignore", out, err],
    windowsHide: true,
    env: normalizeEnv(process.env)
  });
  child.unref();
  return child.pid;
}

function normalizeEnv(env) {
  const next = { ...env };
  if (next.PATH && next.Path) {
    next.Path = next.Path || next.PATH;
    delete next.PATH;
  }
  return next;
}

const serverPid = start("server", ["node_modules/tsx/dist/cli.mjs", "src/server/index.ts"]);
const clientPid = start("client", ["node_modules/vite/bin/vite.js", "--host", "0.0.0.0"]);

console.log(`server pid: ${serverPid}`);
console.log(`client pid: ${clientPid}`);
