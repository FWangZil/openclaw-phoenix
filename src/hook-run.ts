import { type PhoenixNotificationConfig, type PhoenixNotificationDispatch } from "./notify.js";
import { runPhoenixRecovery } from "./recovery.js";
import { type PhoenixActionResult } from "./web-contract.js";

export type PhoenixHookRunOptions = {
  configPath?: string;
  openclawBin: string;
  outputDir: string;
  retain: number;
  env?: NodeJS.ProcessEnv;
  notification?: PhoenixNotificationConfig;
};

export type PhoenixHookRunResult = {
  ok: boolean;
  healthy: boolean;
  backedUpArchivePath?: string;
  latestKnownGoodArchivePath?: string;
  healthReason: string;
  rollbackRestored: boolean;
  restoredArchivePath?: string;
  retentionDeleted: string[];
  notification?: string;
  notificationDelivery: PhoenixNotificationDispatch;
  operation: PhoenixActionResult;
};

export async function runPhoenixHook(options: PhoenixHookRunOptions): Promise<PhoenixHookRunResult> {
  const recovery = await runPhoenixRecovery({
    configPath: options.configPath,
    openclawBin: options.openclawBin,
    outputDir: options.outputDir,
    retain: options.retain,
    env: options.env,
    notification: options.notification,
    origin: "hook",
    selfHeal: true,
  });
  return {
    ok: recovery.ok,
    healthy: recovery.health.healthy,
    backedUpArchivePath: recovery.backup.archivePath,
    latestKnownGoodArchivePath: recovery.knownGood.currentArchivePath,
    healthReason: recovery.health.reason,
    rollbackRestored: recovery.rollback.restored,
    restoredArchivePath: recovery.rollback.archivePath,
    retentionDeleted: recovery.retention.deleted,
    notification: recovery.notificationDelivery.results.find((entry) => !entry.delivered)?.event.message,
    notificationDelivery: recovery.notificationDelivery,
    operation: recovery.operation,
  };
}
