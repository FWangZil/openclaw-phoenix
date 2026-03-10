import { type RetentionResult } from "./retention.js";
import { runPhoenixRecovery } from "./recovery.js";

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

export async function runPhoenixHook(options: {
  configPath?: string;
  openclawBin: string;
  outputDir: string;
  retain: number;
  env?: NodeJS.ProcessEnv;
}): Promise<PhoenixHookRunResult> {
  const recovery = await runPhoenixRecovery(options);
  return {
    ok: recovery.ok,
    healthy: recovery.health.healthy,
    backupArchivePath: recovery.backup.archivePath,
    backupError: recovery.backup.error,
    latestKnownGoodArchivePath: recovery.knownGood.currentArchivePath,
    healthReason: recovery.health.reason,
    rollback: {
      attempted: recovery.rollback.attempted,
      restored: recovery.rollback.restored,
      archivePath: recovery.rollback.archivePath,
      error: recovery.rollback.error,
    },
    retention: recovery.retention,
    notification: recovery.notifications[0]?.message,
  };
}