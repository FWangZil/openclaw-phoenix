import fs from "node:fs/promises";
import path from "node:path";
import { type OpenClawStatusResult, runOpenClawBackupCreate, runOpenClawStatus } from "./backup.js";
import { pruneBackupArchives, type RetentionResult } from "./retention.js";
import { restoreBackupArchive } from "./restore.js";

type PhoenixHookState = {
  schemaVersion: 1;
  latestKnownGoodArchivePath?: string;
  lastBackupArchivePath?: string;
  updatedAt: string;
};

export type PhoenixHookRunResult = {
  ok: boolean;
  healthy: boolean;
  backupArchivePath?: string;
  backupError?: string;
  latestKnownGoodArchivePath?: string;
  healthReason: string;
  rollback: {
    attempted: boolean;
    restored: boolean;
    archivePath?: string;
    error?: string;
  };
  retention?: RetentionResult;
  notification?: string;
};

function resolveStateFilePath(outputDir: string): string {
  return path.join(outputDir, ".openclaw-phoenix-state.json");
}

async function readPhoenixHookState(outputDir: string): Promise<PhoenixHookState> {
  const raw = await fs.readFile(resolveStateFilePath(outputDir), "utf8").catch(() => null);
  if (!raw) {
    return { schemaVersion: 1, updatedAt: new Date(0).toISOString() };
  }
  const parsed = JSON.parse(raw) as Partial<PhoenixHookState>;
  return {
    schemaVersion: 1,
    latestKnownGoodArchivePath: typeof parsed.latestKnownGoodArchivePath === "string"
      ? parsed.latestKnownGoodArchivePath
      : undefined,
    lastBackupArchivePath: typeof parsed.lastBackupArchivePath === "string" ? parsed.lastBackupArchivePath : undefined,
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
  };
}

async function writePhoenixHookState(outputDir: string, state: PhoenixHookState): Promise<void> {
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(resolveStateFilePath(outputDir), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function evaluateStatusHealth(status: OpenClawStatusResult): { healthy: boolean; reason: string } {
  const gateway = status.gateway;
  if (gateway?.misconfigured === true) {
    return { healthy: false, reason: "gateway is misconfigured in openclaw status --json" };
  }
  if (gateway?.reachable === false) {
    return { healthy: false, reason: "gateway is unreachable in openclaw status --json" };
  }
  if (gateway && gateway.reachable === true) {
    return { healthy: true, reason: "gateway reachable" };
  }
  return { healthy: false, reason: "openclaw status --json did not report gateway.reachable=true" };
}

export async function runPhoenixHook(options: {
  configPath?: string;
  openclawBin: string;
  outputDir: string;
  retain: number;
  env?: NodeJS.ProcessEnv;
}): Promise<PhoenixHookRunResult> {
  const effectiveEnv = options.configPath
    ? { ...process.env, ...options.env, OPENCLAW_CONFIG_PATH: options.configPath }
    : (options.env ?? process.env);
  await fs.mkdir(options.outputDir, { recursive: true });
  const state = await readPhoenixHookState(options.outputDir);
  let backupArchivePath: string | undefined;
  let backupError: string | undefined;
  try {
    const backup = await runOpenClawBackupCreate({
      openclawBin: options.openclawBin,
      outputDir: options.outputDir,
      env: effectiveEnv,
    });
    backupArchivePath = backup.archivePath ? path.resolve(backup.archivePath) : undefined;
  } catch (error) {
    backupError = String(error);
  }
  let healthy = false;
  let healthReason = "health check did not run";
  try {
    const status = await runOpenClawStatus({ openclawBin: options.openclawBin, env: effectiveEnv });
    const health = evaluateStatusHealth(status);
    healthy = health.healthy;
    healthReason = health.reason;
  } catch (error) {
    healthReason = `status check failed: ${String(error)}`;
  }
  let notification: string | undefined;
  let rollback: PhoenixHookRunResult["rollback"] = { attempted: false, restored: false };
  if (healthy && backupArchivePath) {
    state.latestKnownGoodArchivePath = backupArchivePath;
  }
  if (!healthy) {
    const candidate = state.latestKnownGoodArchivePath;
    rollback = {
      attempted: Boolean(candidate),
      restored: false,
      archivePath: candidate,
    };
    if (!candidate) {
      notification = `OpenClaw Phoenix detected unhealthy status (${healthReason}) but has no known-good archive to restore.`;
    } else {
      try {
        await restoreBackupArchive({
          archivePath: candidate,
          configPath: options.configPath,
          openclawBin: options.openclawBin,
          yes: true,
          env: effectiveEnv,
          log: () => undefined,
          error: () => undefined,
        });
        rollback.restored = true;
        notification = `OpenClaw Phoenix rolled back to ${path.basename(candidate)} after unhealthy status (${healthReason}).`;
      } catch (error) {
        rollback.error = String(error);
        notification = `OpenClaw Phoenix failed to roll back to ${path.basename(candidate)} after unhealthy status (${healthReason}): ${rollback.error}`;
      }
    }
  }
  state.lastBackupArchivePath = backupArchivePath;
  state.updatedAt = new Date().toISOString();
  await writePhoenixHookState(options.outputDir, state);
  const retention = await pruneBackupArchives({
    directory: options.outputDir,
    retain: options.retain,
    keep: state.latestKnownGoodArchivePath ? [state.latestKnownGoodArchivePath] : undefined,
  });
  const ok = healthy ? !backupError : rollback.restored;
  return {
    ok,
    healthy,
    backupArchivePath,
    backupError,
    latestKnownGoodArchivePath: state.latestKnownGoodArchivePath,
    healthReason,
    rollback,
    retention,
    notification,
  };
}