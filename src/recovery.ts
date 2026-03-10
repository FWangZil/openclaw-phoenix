import fs from "node:fs/promises";
import path from "node:path";
import { type OpenClawStatusResult, runOpenClawBackupCreate, runOpenClawStatus } from "./backup.js";
import {
  dispatchPhoenixNotifications,
  selectPhoenixNotificationEvents,
  type PhoenixNotificationConfig,
  type PhoenixNotificationDispatch,
  type PhoenixRecoveryNotificationEvent,
} from "./notify.js";
import { readPhoenixRecoveryState, type PhoenixRecoveryState, writePhoenixRecoveryState } from "./recovery-state.js";
import { pruneBackupArchives, type RetentionResult } from "./retention.js";
import { restoreBackupArchive } from "./restore.js";
import { recordPhoenixRecoveryAction, type PhoenixActionResult, type PhoenixWebOrigin } from "./web-contract.js";

export type { PhoenixRecoveryState } from "./recovery-state.js";

export type PhoenixRecoveryRequest = {
  configPath?: string;
  openclawBin: string;
  outputDir: string;
  retain: number;
  env?: NodeJS.ProcessEnv;
  notification?: PhoenixNotificationConfig;
  origin?: PhoenixWebOrigin;
  selfHeal?: boolean;
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
  notificationDelivery: PhoenixNotificationDispatch;
  state: PhoenixRecoveryState;
  operation: PhoenixActionResult;
};

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
  const startedAt = new Date().toISOString();
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
          origin: options.origin,
          recordInWebState: false,
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
  const notificationEvents = selectPhoenixNotificationEvents({
    backupArchivePath,
    backupError,
    health,
    notification: options.notification,
    notifications,
    promotedArchivePath,
  });
  const notificationDelivery = await dispatchPhoenixNotifications({
    env: effectiveEnv,
    events: notificationEvents,
    notification: options.notification,
    openclawBin: options.openclawBin,
  });
  const finishedAt = new Date().toISOString();
  const operation = await recordPhoenixRecoveryAction({
    origin: options.origin ?? "manual",
    configPath: options.configPath,
    outputDir: options.outputDir,
    retain: options.retain,
    selfHeal: options.selfHeal,
    notification: options.notification,
    startedAt,
    finishedAt,
    result: {
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
      notificationDelivery,
    },
  });

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
    notificationDelivery,
    state,
    operation,
  };
}
