import fs from "node:fs/promises";
import path from "node:path";
import chokidar from "chokidar";
import { runOpenClawBackupCreate } from "./backup.js";
import { DebouncedRunner } from "./debounced-runner.js";
import { normalizePathKey, shortenHomePath } from "./paths.js";
import { runPhoenixRecovery } from "./recovery.js";
import { pruneBackupArchives } from "./retention.js";
import { type WatchPlan, resolveWatchPlan } from "./watch-plan.js";

export const DEFAULT_DEBOUNCE_MS = 1_000;
export const DEFAULT_RETAIN = 100;

export type StartBackupWatchOptions = {
  configPath?: string;
  debounceMs?: number;
  env?: NodeJS.ProcessEnv;
  openclawBin: string;
  outputDir: string;
  retain?: number;
  selfHeal?: boolean;
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

async function runBackupOnlyWatchCycle(options: StartBackupWatchOptions, effectiveEnv: NodeJS.ProcessEnv, log: (message: string) => void) {
  const result = await runOpenClawBackupCreate({
    openclawBin: options.openclawBin,
    outputDir: `${options.outputDir}${path.sep}`,
    env: effectiveEnv,
  });
  const retention = await pruneBackupArchives({
    directory: options.outputDir,
    retain: options.retain ?? DEFAULT_RETAIN,
  });
  log(`backup complete: ${formatArchivePath(result.archivePath, effectiveEnv)}`);
  if (retention.deleted.length > 0) {
    log(`retention pruned ${retention.deleted.length} old archive(s)`);
  }
}

async function runSelfHealWatchCycle(
  options: StartBackupWatchOptions,
  effectiveEnv: NodeJS.ProcessEnv,
  log: (message: string) => void,
  error: (message: string) => void,
) {
  const recovery = await runPhoenixRecovery({
    configPath: options.configPath,
    openclawBin: options.openclawBin,
    outputDir: options.outputDir,
    retain: options.retain ?? DEFAULT_RETAIN,
    env: effectiveEnv,
  });
  if (recovery.backup.archivePath) {
    log(`backup complete: ${formatArchivePath(recovery.backup.archivePath, effectiveEnv)}`);
  }
  if (recovery.backup.error) {
    error(`backup cycle failed: ${recovery.backup.error}`);
  }
  log(`health: ${recovery.health.healthy ? "healthy" : "unhealthy"} (${recovery.health.reason})`);
  if (recovery.knownGood.promotedArchivePath) {
    log(`latest-known-good updated: ${formatArchivePath(recovery.knownGood.promotedArchivePath, effectiveEnv)}`);
  }
  for (const notification of recovery.notifications) {
    if (notification.severity === "error") {
      error(notification.message);
    } else {
      log(notification.message);
    }
  }
  if (recovery.retention.deleted.length > 0) {
    log(`retention pruned ${recovery.retention.deleted.length} old archive(s)`);
  }
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
    try {
      await queueRefresh();
      if (options.selfHeal) {
        await runSelfHealWatchCycle(options, effectiveEnv, log, error);
      } else {
        await runBackupOnlyWatchCycle(options, effectiveEnv, log);
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
    runner.close();
    await watcher.close();
    closedResolver();
  };
  options.signal?.addEventListener("abort", () => {
    void close();
  });
  return { close, closed };
}