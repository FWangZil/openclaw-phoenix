import fs from "node:fs/promises";
import path from "node:path";
import JSON5 from "json5";
import { resolveOutputDir } from "./paths.js";
import { resolveWatchPlan } from "./watch-plan.js";

type JsonRecord = Record<string, unknown>;

export const PHOENIX_HOOK_NAME = "openclaw-phoenix-backup-rollback";
export const DEFAULT_HOOK_EVENT = "gateway:startup";

type HookInstallRecord = {
  managedBy: "openclaw-phoenix";
  schemaVersion: 1 | 2;
  hookName: string;
  eventKey: string;
  phoenixCommand: string[];
  openclawBin: string;
  outputDir: string;
  retain: number;
  previousInternalEnabledState: "unset" | "false" | "true";
};

export type HookInstallResult = {
  configPath: string;
  hookDir: string;
  eventKey: string;
  changed: boolean;
};

export type HookRemoveResult = {
  configPath: string;
  hookDir: string;
  changed: boolean;
};

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function isEmptyRecord(value: unknown): boolean {
  const record = asRecord(value);
  return record !== null && Object.keys(record).length === 0;
}

function deleteIfEmpty(parent: JsonRecord, key: string) {
  if (isEmptyRecord(parent[key])) {
    delete parent[key];
  }
}

async function readRootConfig(configPath: string): Promise<JsonRecord> {
  const raw = await fs.readFile(configPath, "utf8").catch((error: unknown) => {
    const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (raw === null) {
    return {};
  }
  const parsed = JSON5.parse(raw);
  const record = asRecord(parsed);
  if (!record) {
    throw new Error(`OpenClaw config root must be an object: ${configPath}`);
  }
  return record;
}

async function writeRootConfig(configPath: string, config: JsonRecord): Promise<void> {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function resolveHookDir(stateDir: string): string {
  return path.join(stateDir, "hooks", PHOENIX_HOOK_NAME);
}

function resolveInstallRecordPath(hookDir: string): string {
  return path.join(hookDir, "install-record.json");
}

async function readInstallRecord(hookDir: string): Promise<HookInstallRecord | null> {
  const raw = await fs.readFile(resolveInstallRecordPath(hookDir), "utf8").catch(() => null);
  if (!raw) {
    return null;
  }
  const parsed = JSON.parse(raw) as Partial<HookInstallRecord> & { phoenixBin?: string };
  if (parsed?.managedBy !== "openclaw-phoenix" || parsed?.hookName !== PHOENIX_HOOK_NAME) {
    return null;
  }
  const phoenixCommand = Array.isArray(parsed.phoenixCommand)
    ? parsed.phoenixCommand.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : typeof parsed.phoenixBin === "string" && parsed.phoenixBin.trim().length > 0
      ? [parsed.phoenixBin]
      : [];
  if (phoenixCommand.length === 0) {
    return null;
  }
  return {
    managedBy: "openclaw-phoenix",
    schemaVersion: parsed.schemaVersion === 1 ? 1 : 2,
    hookName: PHOENIX_HOOK_NAME,
    eventKey: typeof parsed.eventKey === "string" && parsed.eventKey.trim() ? parsed.eventKey : DEFAULT_HOOK_EVENT,
    phoenixCommand,
    openclawBin: typeof parsed.openclawBin === "string" ? parsed.openclawBin : "openclaw",
    outputDir: typeof parsed.outputDir === "string" ? parsed.outputDir : resolveOutputDir(),
    retain: typeof parsed.retain === "number" && Number.isInteger(parsed.retain) && parsed.retain > 0 ? parsed.retain : 100,
    previousInternalEnabledState:
      parsed.previousInternalEnabledState === "false" || parsed.previousInternalEnabledState === "true"
        ? parsed.previousInternalEnabledState
        : "unset",
  };
}

async function assertHookDirOwnedByPhoenix(hookDir: string): Promise<void> {
  const stat = await fs.stat(hookDir).catch(() => null);
  if (!stat) {
    return;
  }
  if (!stat.isDirectory()) {
    throw new Error(`Refusing to install Phoenix hook over non-directory path: ${hookDir}`);
  }
  const record = await readInstallRecord(hookDir);
  if (!record) {
    throw new Error(`Refusing to overwrite unmanaged hook directory: ${hookDir}`);
  }
}

function renderHookReadme(eventKey: string): string {
  return `---\nname: ${PHOENIX_HOOK_NAME}\ndescription: Backup current OpenClaw state and roll back to the last known-good archive when status is unhealthy.\nevents:\n  - ${eventKey}\n---\n\n# OpenClaw Phoenix Backup + Rollback Hook\n\nManaged by openclaw-phoenix.\n`;
}

function renderHookHandler(options: {
  phoenixCommand: string[];
  openclawBin: string;
  configPath: string;
  outputDir: string;
  retain: number;
}): string {
  const args = [
    "hook",
    "run",
    "--json",
    "--config",
    options.configPath,
    "--openclaw-bin",
    options.openclawBin,
    "--output",
    options.outputDir,
    "--retain",
    String(options.retain),
  ];
  return `const { spawn } = require("node:child_process");

const PHOENIX_COMMAND = ${JSON.stringify(options.phoenixCommand)};
const PHOENIX_ARGS = ${JSON.stringify(args)};

function invokePhoenix() {
  return new Promise((resolve, reject) => {
    const stdout = [];
    const stderr = [];
    const child = spawn(PHOENIX_COMMAND[0], [...PHOENIX_COMMAND.slice(1), ...PHOENIX_ARGS], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      const stdoutText = stdout.join("").trim();
      const stderrText = stderr.join("").trim();
      const summary = stdoutText ? safeParseJson(stdoutText) : null;
      if (signal) {
        resolve({ ok: false, summary, message: "OpenClaw Phoenix hook exited via signal " + signal });
        return;
      }
      if ((code ?? 1) !== 0) {
        resolve({
          ok: false,
          summary,
          message:
            (summary && typeof summary.notification === "string" && summary.notification) ||
            stderrText ||
            stdoutText ||
            "OpenClaw Phoenix hook failed with exit " + (code ?? 1),
        });
        return;
      }
      resolve({ ok: true, summary, message: summary && typeof summary.notification === "string" ? summary.notification : null });
    });
  });
}

function safeParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

module.exports = async function openclawPhoenixBackupRollback(event) {
  const result = await invokePhoenix().catch((error) => ({ ok: false, summary: null, message: String(error) }));
  if (Array.isArray(event && event.messages) && result.message) {
    event.messages.push(result.message);
  }
  if (!result.ok && result.message) {
    console.error(result.message);
  }
};
`;
}

export async function installPhoenixHook(options: {
  configPath?: string;
  phoenixCommand: string[];
  openclawBin: string;
  outputDir: string;
  retain: number;
  eventKey?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<HookInstallResult> {
  const plan = await resolveWatchPlan({ configPath: options.configPath, env: options.env });
  const configPath = plan.rootConfigPath;
  const hookDir = resolveHookDir(plan.stateDir);
  const eventKey = options.eventKey?.trim() || DEFAULT_HOOK_EVENT;
  if (!eventKey.includes(":")) {
    throw new Error(`hook event must include a type and action (received ${eventKey})`);
  }
  if (options.phoenixCommand.length === 0) {
    throw new Error("Phoenix hook install requires a non-empty phoenix command");
  }
  await assertHookDirOwnedByPhoenix(hookDir);
  const config = await readRootConfig(configPath);
  const hooks = asRecord(config.hooks) ?? {};
  const internal = asRecord(hooks.internal) ?? {};
  const entries = asRecord(internal.entries) ?? {};
  const existingEntry = asRecord(entries[PHOENIX_HOOK_NAME]);
  if (existingEntry && existingEntry.managedBy !== "openclaw-phoenix") {
    throw new Error(`Refusing to overwrite unmanaged hook entry ${PHOENIX_HOOK_NAME}`);
  }
  const previousInternalEnabledState = internal.enabled === true ? "true" : internal.enabled === false ? "false" : "unset";
  entries[PHOENIX_HOOK_NAME] = {
    ...existingEntry,
    enabled: true,
    managedBy: "openclaw-phoenix",
    eventKey,
  };
  internal.enabled = true;
  internal.entries = entries;
  hooks.internal = internal;
  config.hooks = hooks;
  await writeRootConfig(configPath, config);
  await fs.mkdir(hookDir, { recursive: true });
  await fs.writeFile(path.join(hookDir, "HOOK.md"), renderHookReadme(eventKey), "utf8");
  await fs.writeFile(
    path.join(hookDir, "handler.js"),
    renderHookHandler({
      phoenixCommand: options.phoenixCommand,
      openclawBin: options.openclawBin,
      configPath,
      outputDir: resolveOutputDir(options.outputDir),
      retain: options.retain,
    }),
    { encoding: "utf8", mode: 0o755 },
  );
  const record: HookInstallRecord = {
    managedBy: "openclaw-phoenix",
    schemaVersion: 2,
    hookName: PHOENIX_HOOK_NAME,
    eventKey,
    phoenixCommand: options.phoenixCommand,
    openclawBin: options.openclawBin,
    outputDir: resolveOutputDir(options.outputDir),
    retain: options.retain,
    previousInternalEnabledState,
  };
  await fs.writeFile(resolveInstallRecordPath(hookDir), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return { configPath, hookDir, eventKey, changed: true };
}

export async function removePhoenixHook(options: {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<HookRemoveResult> {
  const plan = await resolveWatchPlan({ configPath: options.configPath, env: options.env });
  const configPath = plan.rootConfigPath;
  const hookDir = resolveHookDir(plan.stateDir);
  const record = await readInstallRecord(hookDir);
  const hookDirStat = await fs.stat(hookDir).catch(() => null);
  if (hookDirStat?.isDirectory() && !record) {
    throw new Error(`Refusing to remove unmanaged hook directory: ${hookDir}`);
  }
  const config = await readRootConfig(configPath);
  const hooks = asRecord(config.hooks);
  const internal = asRecord(hooks?.internal);
  const entries = asRecord(internal?.entries);
  const existingEntry = asRecord(entries?.[PHOENIX_HOOK_NAME]);
  if (existingEntry && existingEntry.managedBy !== "openclaw-phoenix") {
    throw new Error(`Refusing to remove unmanaged hook entry ${PHOENIX_HOOK_NAME}`);
  }
  let changed = false;
  if (entries && PHOENIX_HOOK_NAME in entries) {
    delete entries[PHOENIX_HOOK_NAME];
    changed = true;
    if (Object.keys(entries).length === 0) {
      delete internal?.entries;
    }
  }
  if (internal && record) {
    if (record.previousInternalEnabledState === "unset") {
      delete internal.enabled;
    }
    if (record.previousInternalEnabledState === "false") {
      internal.enabled = false;
    }
  }
  if (internal) {
    deleteIfEmpty(internal, "load");
    deleteIfEmpty(internal, "installs");
  }
  if (hooks && internal) {
    if (Object.keys(internal).length === 0) {
      delete hooks.internal;
    }
    if (Object.keys(hooks).length === 0) {
      delete config.hooks;
    }
  }
  await writeRootConfig(configPath, config);
  if (hookDirStat?.isDirectory()) {
    await fs.rm(hookDir, { recursive: true, force: true });
    changed = true;
  }
  return { configPath, hookDir, changed };
}