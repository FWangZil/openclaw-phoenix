import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import chokidar from "chokidar";
import { runOpenClawBackupCreateBatch, runOpenClawCommand } from "./backup.js";
import { DebouncedRunner } from "./debounced-runner.js";
import { type PhoenixNotificationConfig } from "./notify.js";
import { normalizePathKey, shortenHomePath } from "./paths.js";
import { runPhoenixRecovery } from "./recovery.js";
import { prunePhoenixBackupArchives } from "./retention.js";
import { type WatchPlan, resolveWatchPlan } from "./watch-plan.js";
import { recordPhoenixBackupWatchAction } from "./web-contract.js";

export const DEFAULT_DEBOUNCE_MS = 1_000;
export const DEFAULT_RETAIN = 100;
const DEFAULT_GATEWAY_PORT = 18_789;
const GATEWAY_PROBE_TIMEOUT_MS = 300;

export type StartBackupWatchOptions = {
  configPath?: string;
  debounceMs?: number;
  env?: NodeJS.ProcessEnv;
  gatewayPort?: number;
  openclawBin: string;
  outputDir: string;
  probeGatewayPort?: (options: { env: NodeJS.ProcessEnv; port: number }) => Promise<boolean>;
  retain?: number;
  selfHeal?: boolean;
  notification?: PhoenixNotificationConfig;
  log?: (message: string) => void;
  error?: (message: string) => void;
  signal?: AbortSignal;
};

export type BackupWatchSession = {
  close: () => Promise<void>;
  closed: Promise<void>;
};

function formatArchivePath(archivePath: string | undefined, env: NodeJS.ProcessEnv): string {
  return archivePath ? shortenHomePath(archivePath, env) : "(path unavailable)";
}

async function probeLocalGatewayPort(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(GATEWAY_PROBE_TIMEOUT_MS);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function ensureGatewayPhoenix(options: {
  env: NodeJS.ProcessEnv;
  error: (message: string) => void;
  gatewayPort: number;
  log: (message: string) => void;
  openclawBin: string;
  probeGatewayPort?: (options: { env: NodeJS.ProcessEnv; port: number }) => Promise<boolean>;
}) {
  const probe = options.probeGatewayPort ?? ((probeOptions: { port: number }) => probeLocalGatewayPort(probeOptions.port));
  const listening = await probe({ env: options.env, port: options.gatewayPort });
  if (listening) {
    return;
  }
  options.error(
    `gateway phoenix detected no process on 127.0.0.1:${options.gatewayPort}; attempting openclaw gateway start`,
  );
  try {
    await runOpenClawCommand({
      openclawBin: options.openclawBin,
      args: ["gateway", "start"],
      env: options.env,
      label: "openclaw gateway start",
    });
    options.log(`gateway phoenix restarted local gateway on 127.0.0.1:${options.gatewayPort}`);
    return;
  } catch (startError) {
    options.error(`gateway phoenix start failed: ${String(startError)}; attempting install + start`);
  }
  await runOpenClawCommand({
    openclawBin: options.openclawBin,
    args: ["gateway", "install"],
    env: options.env,
    label: "openclaw gateway install",
  });
  await runOpenClawCommand({
    openclawBin: options.openclawBin,
    args: ["gateway", "start"],
    env: options.env,
    label: "openclaw gateway start",
  });
  options.log(`gateway phoenix reinstalled and restarted local gateway on 127.0.0.1:${options.gatewayPort}`);
}

async function runBackupOnlyWatchCycle(options: StartBackupWatchOptions, effectiveEnv: NodeJS.ProcessEnv, log: (message: string) => void) {
  const startedAt = new Date().toISOString();
  try {
    const result = await runOpenClawBackupCreateBatch({
      openclawBin: options.openclawBin,
      outputDir: `${options.outputDir}${path.sep}`,
      env: effectiveEnv,
    });
    const retention = await prunePhoenixBackupArchives({
      directory: options.outputDir,
      retain: options.retain ?? DEFAULT_RETAIN,
    });
    await recordPhoenixBackupWatchAction({
      configPath: options.configPath,
      outputDir: options.outputDir,
      retain: options.retain ?? DEFAULT_RETAIN,
      startedAt,
      finishedAt: new Date().toISOString(),
      backup: {
        attempted: true,
        archivePath: result.archivePath,
        configOnlyArchivePath: result.configOnlyArchivePath,
        error: result.error,
      },
      retention,
    });
    if (result.configOnlyArchivePath) {
      log(`config-only backup complete: ${formatArchivePath(result.configOnlyArchivePath, effectiveEnv)}`);
    }
    log(`backup complete: ${formatArchivePath(result.archivePath, effectiveEnv)}`);
    if (retention.deleted.length > 0) {
      log(`retention pruned ${retention.deleted.length} old archive(s)`);
    }
    if (result.error) {
      throw new Error(result.error);
    }
  } catch (error) {
    await recordPhoenixBackupWatchAction({
      configPath: options.configPath,
      outputDir: options.outputDir,
      retain: options.retain ?? DEFAULT_RETAIN,
      startedAt,
      finishedAt: new Date().toISOString(),
      backup: {
        attempted: true,
        error: String(error),
      },
      retention: { kept: [], deleted: [] },
    });
    throw error;
  }
}

async function runSelfHealWatchCycle(
  options: StartBackupWatchOptions,
  effectiveEnv: NodeJS.ProcessEnv,
  log: (message: string) => void,
  error: (message: string) => void,
): Promise<boolean> {
  const recovery = await runPhoenixRecovery({
    configPath: options.configPath,
    openclawBin: options.openclawBin,
    outputDir: options.outputDir,
    retain: options.retain ?? DEFAULT_RETAIN,
    env: effectiveEnv,
    notification: options.notification,
    origin: "watch",
    selfHeal: true,
  });
  if (recovery.backup.archivePath) {
    log(`backup complete: ${formatArchivePath(recovery.backup.archivePath, effectiveEnv)}`);
  }
  if (recovery.backup.configOnlyArchivePath) {
    log(`config-only backup complete: ${formatArchivePath(recovery.backup.configOnlyArchivePath, effectiveEnv)}`);
  }
  if (recovery.backup.error) {
    error(`backup cycle failed: ${recovery.backup.error}`);
  }
  log(`health: ${recovery.health.healthy ? "healthy" : "unhealthy"} (${recovery.health.reason})`);
  if (recovery.knownGood.promotedArchivePath) {
    log(`latest-known-good updated: ${formatArchivePath(recovery.knownGood.promotedArchivePath, effectiveEnv)}`);
  }
  for (const delivery of recovery.notificationDelivery.results) {
    if (delivery.delivered) {
      continue;
    }
    if (delivery.error) {
      error(`notification delivery failed (${delivery.event.code}): ${delivery.error}`);
    }
    if (delivery.event.severity === "error") {
      error(delivery.event.message);
    } else {
      log(delivery.event.message);
    }
  }
  if (recovery.retention.deleted.length > 0) {
    log(`retention pruned ${recovery.retention.deleted.length} old archive(s)`);
  }
  return recovery.rollback.restored;
}

export async function startBackupWatch(options: StartBackupWatchOptions): Promise<BackupWatchSession> {
  const log = options.log ?? console.log;
  const error = options.error ?? console.error;
  const env = options.env ?? process.env;
  if (!Number.isInteger(options.retain ?? DEFAULT_RETAIN) || (options.retain ?? DEFAULT_RETAIN) < 1) {
    throw new Error(`retain must be a positive integer, got ${options.retain}`);
  }
  const effectiveEnv = {
    ...env,
    ...(options.configPath ? { OPENCLAW_CONFIG_PATH: options.configPath } : {}),
  };
  await fs.mkdir(options.outputDir, { recursive: true });
  let currentPlan = await resolveWatchPlan({ configPath: options.configPath, env: effectiveEnv });
  for (const warning of currentPlan.warnings) {
    error(warning);
  }
  let closedResolver = () => {};
  const closed = new Promise<void>((resolve) => {
    closedResolver = resolve;
  });
  const watcher = chokidar.watch(currentPlan.targets, {
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: options.debounceMs ?? DEFAULT_DEBOUNCE_MS,
      pollInterval: 100,
    },
    usePolling: env.VITEST === "true",
  });
  let refreshChain: Promise<WatchPlan> = Promise.resolve(currentPlan);
  let configChangedSinceLastCycle = false;
  const applyPlan = async (nextPlan: WatchPlan) => {
    const current = new Set(currentPlan.targets);
    const next = new Set(nextPlan.targets);
    const removed = currentPlan.targets.filter((entry) => !next.has(entry));
    const added = nextPlan.targets.filter((entry) => !current.has(entry));
    if (removed.length > 0) {
      await watcher.unwatch(removed);
    }
    if (added.length > 0) {
      watcher.add(added);
    }
    currentPlan = nextPlan;
  };
  const queueRefresh = () => {
    refreshChain = refreshChain
      .then(async () => {
        const nextPlan = await resolveWatchPlan({ configPath: options.configPath, env: effectiveEnv });
        if (nextPlan.warnings.length > 0) {
          for (const warning of nextPlan.warnings) {
            error(warning);
          }
          return currentPlan;
        }
        await applyPlan(nextPlan);
        return currentPlan;
      })
      .catch((refreshError) => {
        error(`watch target refresh failed: ${String(refreshError)}`);
        return currentPlan;
      });
    return refreshChain;
  };
  const runner = new DebouncedRunner(options.debounceMs ?? DEFAULT_DEBOUNCE_MS, async () => {
    const configChangedForCycle = configChangedSinceLastCycle;
    configChangedSinceLastCycle = false;
    try {
      await queueRefresh();
      let restoredBackup = false;
      if (options.selfHeal) {
        restoredBackup = await runSelfHealWatchCycle(options, effectiveEnv, log, error);
      } else {
        await runBackupOnlyWatchCycle(options, effectiveEnv, log);
      }
      if (!configChangedForCycle || restoredBackup) {
        await ensureGatewayPhoenix({
          env: effectiveEnv,
          error,
          gatewayPort: options.gatewayPort ?? DEFAULT_GATEWAY_PORT,
          log,
          openclawBin: options.openclawBin,
          probeGatewayPort: options.probeGatewayPort,
        });
      }
    } catch (backupError) {
      error(`${options.selfHeal ? "self-heal" : "backup"} cycle failed: ${String(backupError)}`);
    }
  });
  watcher.on("all", (_event, changedPath) => {
    if (changedPath) {
      log(`change detected: ${shortenHomePath(String(changedPath), effectiveEnv)}`);
    }
    if (
      changedPath &&
      normalizePathKey(String(changedPath)) === normalizePathKey(currentPlan.rootConfigPath)
    ) {
      configChangedSinceLastCycle = true;
      void queueRefresh();
    }
    runner.trigger();
  });
  watcher.on("error", (watchError) => {
    error(`watcher error: ${String(watchError)}`);
  });
  log(`watching ${currentPlan.targets.length} path(s) for backup changes`);
  log(`output directory: ${shortenHomePath(options.outputDir, effectiveEnv)}`);
  log(`watch mode: ${options.selfHeal ? "self-heal" : "backup-only"}`);
  const close = async () => {
    await watcher.close();
    await runner.close();
    closedResolver();
  };
  options.signal?.addEventListener("abort", () => {
    void close();
  });
  return { close, closed };
}
