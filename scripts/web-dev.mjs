#!/usr/bin/env node
import { spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

const viteHost = process.env.PHOENIX_WEB_DEV_ASSET_HOST ?? "127.0.0.1";
const vitePort = process.env.PHOENIX_WEB_DEV_ASSET_PORT ?? "5173";
const devOrigin = `http://${viteHost}:${vitePort}`;
const forwardedArgs = process.argv.slice(2);

const viteCli = fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url));
const tsxCli = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));

const children = [];
let shuttingDown = false;
let exitCode = 0;

function spawnChild(name, command, args) {
  const child = spawn(command, args, {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: {
      ...process.env,
      FORCE_COLOR: process.env.FORCE_COLOR ?? "1",
    },
    stdio: "inherit",
  });
  child.on("exit", (code, signal) => {
    if (shuttingDown) {
      return;
    }
    exitCode = code ?? (signal ? 1 : 0);
    console.error(`${name} exited${signal ? ` with signal ${signal}` : ` with code ${exitCode}`}`);
    shutdown();
  });
  children.push(child);
  return child;
}

function shutdown(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) {
      child.kill(signal ?? "SIGTERM");
    }
  }
  process.exit(exitCode);
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

spawnChild("vite", process.execPath, [
  viteCli,
  "--config",
  "./web/vite.config.ts",
  "--host",
  viteHost,
  "--port",
  vitePort,
  "--strictPort",
]);

spawnChild("phoenix-web", process.execPath, [
  tsxCli,
  "watch",
  "./src/cli.ts",
  "web",
  "serve",
  "--dev-origin",
  devOrigin,
  ...forwardedArgs,
]);
