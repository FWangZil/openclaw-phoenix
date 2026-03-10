import fs from "node:fs/promises";
import path from "node:path";
import { type OpenClawStatusResult, runOpenClawBackupCreate, runOpenClawStatus } from "./backup.js";
import { pruneBackupArchives, type RetentionResult } from "./retention.js";
import { restoreBackupArchive } from "./restore.js";

export type PhoenixRecoveryState = {
  schemaVersion: 1;
  latestKnownGoodArchivePath?: string;
  lastBackupArchivePath?: string;
  updatedAt: string;
};

export type PhoenixRecoveryRequest = {
  configPath?: string;
  openclawBin: string;
  outputDir: string;
  retain: number;
  env?: NodeJS.ProcessEnv;
};

export type PhoenixRecoveryNotificationEvent = {
  code: "rollback-failed" | "rollback-missing-known-good" | "rollback-restored";
  severity: "error" | "warning";
  message: string;
};

export type PhoenixRecoveryResult = {
  ok: boolean;
  backup: {
    attempted: true;
    archivePath?: string;
    error?: string;
  };
  health: {
    healthy: boolean;
    reason: string;
  };
  knownGood: {
    previousArchivePath?: string;
    currentArchivePath?: string;
    promotedArchivePath?: string;
  };
  rollback: {
    needed: boolean;
    attempted: boolean;
    restored: boolean;
    archivePath?: string;
    error?: string;
  };
  retention: RetentionResult;
  notifications: PhoenixRecoveryNotificationEvent[];
  state: PhoenixRecoveryState;
};

function resolveStateFilePath(outputDir: string): string {
  return path.join(outputDir, ".openclaw-phoenix-state.json");
}

async function readPhoenixRecoveryState(outputDir: string): Promise<PhoenixRecoveryState> {
  const raw = await fs.readFile(resolveStateFilePath(outputDir), "utf8").catch(() => null);
  if (!raw) {
    return { schemaVersion: 1, updatedAt: new Date(0).toISOString() };
  }
  const parsed = JSON.parse(raw) as Partial<PhoenixRecoveryState>;
  return {
    schemaVersion: 1,
    latestKnownGoodArchivePath: typeof parsed.latestKnownGoodArchivePath === "string"
      ? parsed.latestKnownGoodArchivePath
      : undefined,
    lastBackupArchivePath: typeof parsed.lastBackupArchivePath === "string" ? parsed.lastBackupArchivePath : undefined,
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
  };
}

async function writePhoenixRecoveryState(outputDir: string, state: PhoenixRecoveryState): Promise<void> {
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(resolveStateFilePath(outputDir), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function evaluateStatusHealth(status: OpenClawStatusResult): PhoenixRecoveryResult["health"] {
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

function buildRollbackNotification(options: {
  archivePath?: string;
  healthReason: string;
  rollbackError?: string;
  restored: boolean;
}): PhoenixRecoveryNotificationEvent {
  if (!options.archivePath) {
    return {
      code: "rollback-missing-known-good",
      severity: "warning",
      message: `OpenClaw Phoenix detected unhealthy status (${options.healthReason}) but has no known-good archive to restore.`,
    };
  }
  if (options.restored) {
    return {
      code: "rollback-restored",
      severity: "warning",
      message: `OpenClaw Phoenix rolled back to ${path.basename(options.archivePath)} after unhealthy status (${options.healthReason}).`,
    };
  }
  return {
    code: "rollback-failed",
    severity: "error",
    message: `OpenClaw Phoenix failed to roll back to ${path.basename(options.archivePath)} after unhealthy status (${options.healthReason}): ${options.rollbackError}`,
  };
}

export async function runPhoenixRecovery(options: PhoenixRecoveryRequest): Promise<PhoenixRecoveryResult> {
  const effectiveEnv = options.configPath
    ? { ...process.env, ...options.env, OPENCLAW_CONFIG_PATH: options.configPath }
    : (options.env ?? process.env);
  await fs.mkdir(options.outputDir, { recursive: true });
  const state = await readPhoenixRecoveryState(options.outputDir);
  const previousKnownGoodArchivePath = state.latestKnownGoodArchivePath;

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

  let health = { healthy: false, reason: "health check did not run" };
  try {
    health = evaluateStatusHealth(await runOpenClawStatus({ openclawBin: options.openclawBin, env: effectiveEnv }));
  } catch (error) {
    health = { healthy: false, reason: `status check failed: ${String(error)}` };
  }

  let promotedArchivePath: string | undefined;
  if (health.healthy && backupArchivePath) {
    state.latestKnownGoodArchivePath = backupArchivePath;
    promotedArchivePath = backupArchivePath;
  }

  const rollback: PhoenixRecoveryResult["rollback"] = {
    needed: !health.healthy,
    attempted: false,
    restored: false,
  };
  const notifications: PhoenixRecoveryNotificationEvent[] = [];

  if (!health.healthy) {
    const candidate = state.latestKnownGoodArchivePath;
    rollback.attempted = Boolean(candidate);
    rollback.archivePath = candidate;
    if (!candidate) {
      notifications.push(buildRollbackNotification({ healthReason: health.reason, restored: false }));
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
      } catch (error) {
        rollback.error = String(error);
      }
      notifications.push(
        buildRollbackNotification({
          archivePath: candidate,
          healthReason: health.reason,
          rollbackError: rollback.error,
          restored: rollback.restored,
        }),
      );
    }
  }

  state.lastBackupArchivePath = backupArchivePath;
  state.updatedAt = new Date().toISOString();
  await writePhoenixRecoveryState(options.outputDir, state);

  const retention = await pruneBackupArchives({
    directory: options.outputDir,
    retain: options.retain,
    keep: state.latestKnownGoodArchivePath ? [state.latestKnownGoodArchivePath] : undefined,
  });
  const ok = health.healthy ? !backupError : rollback.restored;

  return {
    ok,
    backup: {
      attempted: true,
      archivePath: backupArchivePath,
      error: backupError,
    },
    health,
    knownGood: {
      previousArchivePath: previousKnownGoodArchivePath,
      currentArchivePath: state.latestKnownGoodArchivePath,
      promotedArchivePath,
    },
    rollback,
    retention,
    notifications,
    state,
  };
}