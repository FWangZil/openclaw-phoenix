import process from "node:process";
import { resolveUserPath } from "./paths.js";

const TS_ENTRYPOINT_RE = /\.(cts|mts|ts|tsx)$/i;
const JS_ENTRYPOINT_RE = /\.(cjs|mjs|js)$/i;

function resolveEntrypointCommand(entryPath: string, execPath: string): string[] {
  const resolvedEntry = resolveUserPath(entryPath);
  if (TS_ENTRYPOINT_RE.test(resolvedEntry)) {
    return [execPath, "--import", "tsx", resolvedEntry];
  }
  if (JS_ENTRYPOINT_RE.test(resolvedEntry)) {
    return [execPath, resolvedEntry];
  }
  return [resolvedEntry];
}

export function resolvePhoenixCommand(options: {
  phoenixBin?: string;
  argv?: string[];
  execPath?: string;
} = {}): string[] {
  const execPath = options.execPath ?? process.execPath;
  const phoenixBin = options.phoenixBin?.trim();
  if (phoenixBin) {
    return resolveEntrypointCommand(phoenixBin, execPath);
  }
  const currentEntrypoint = options.argv?.[1]?.trim();
  if (currentEntrypoint) {
    return resolveEntrypointCommand(currentEntrypoint, execPath);
  }
  return ["openclaw-phoenix"];
}

export function formatShellCommand(command: string[]): string {
  return command.map((part) => (/[\s"']/u.test(part) ? JSON.stringify(part) : part)).join(" ");
}