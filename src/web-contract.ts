import { constants as fsConstants } from "node:fs";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_HOOK_EVENT,
  readPhoenixHookInstallRecord,
  resolvePhoenixHookDir,
  type PhoenixHookInstallRecord,
} from "./hook-install.js";
import {
  type PhoenixNotificationConfig,
  type PhoenixNotificationDispatch,
  type PhoenixNotificationTarget,
  type PhoenixRecoveryNotificationEvent,
} from "./notify.js";
import { normalizePathKey } from "./paths.js";
import { readPhoenixRecoveryState } from "./recovery-state.js";
import { OPENCLAW_BACKUP_ARCHIVE_SUFFIX, type RetentionResult } from "./retention.js";
import { resolveWatchPlan } from "./watch-plan.js";

const PHOENIX_WEB_STATE_FILENAME = ".openclaw-phoenix-web-v1.json";
const PHOENIX_WEB_SCHEMA_VERSION = 1;
const MAX_PHOENIX_WEB_HISTORY = 100;
const DEFAULT_PHOENIX_RETAIN = 100;

export type PhoenixWebOrigin = "watch" | "hook" | "manual";
export type PhoenixWebOperation = "backup-cycle" | "recovery-cycle" | "restore";
export type PhoenixWebActionStatus = "ok" | "warning" | "error";
export type PhoenixWebNotificationMode = "off" | "exceptional-only" | "all";

export type PhoenixWebNotificationConfigSummary = {
  enabled: boolean;
  policy: PhoenixWebNotificationMode;
  target?: PhoenixNotificationTarget;
  targetConfigured: boolean;
};

export type PhoenixWebRunConfig = {
  configPath?: string;
  outputDir: string;
  retain?: number;
  selfHeal?: boolean;
  dryRun?: boolean;
  notification: PhoenixWebNotificationConfigSummary;
};

export type PhoenixWebBackupResult = {
  attempted: boolean;
  archivePath?: string;
  error?: string;
};

export type PhoenixWebHealthResult = {
  attempted: boolean;
  healthy?: boolean;
  reason?: string;
};

export type PhoenixWebKnownGoodResult = {
  previousArchivePath?: string;
  currentArchivePath?: string;
  promotedArchivePath?: string;
};

export type PhoenixWebRollbackResult = {
  needed: boolean;
  attempted: boolean;
  restored: boolean;
  archivePath?: string;
  error?: string;
};

export type PhoenixWebNotificationResult = {
  events: PhoenixRecoveryNotificationEvent[];
  delivery: PhoenixNotificationDispatch["results"];
  status: "idle" | "suppressed" | "not-configured" | "delivered" | "failed";
};

export type PhoenixWebRestoreResult = {
  attempted: true;
  dryRun: boolean;
  archivePath: string;
  archiveRoot?: string;
  assetCount?: number;
  restoredPaths: string[];
  error?: string;
  verification?: {
    archiveRoot: string;
    createdAt: string;
    runtimeVersion: string;
    assetCount: number;
    entryCount: number;
  };
};

export type PhoenixActionResult = {
  schemaVersion: 1;
  id: string;
  origin: PhoenixWebOrigin;
  operation: PhoenixWebOperation;
  status: PhoenixWebActionStatus;
  startedAt: string;
  finishedAt: string;
  summary: string;
  config: PhoenixWebRunConfig;
  backup?: PhoenixWebBackupResult;
  health?: PhoenixWebHealthResult;
  knownGood?: PhoenixWebKnownGoodResult;
  rollback?: PhoenixWebRollbackResult;
  notification?: PhoenixWebNotificationResult;
  restore?: PhoenixWebRestoreResult;
  retention?: RetentionResult;
};

type PhoenixWebState = {
  schemaVersion: 1;
  updatedAt: string;
  history: PhoenixActionResult[];
};

type PhoenixLatestResult<T> = {
  operationId: string;
  origin: PhoenixWebOrigin;
  finishedAt: string;
  actionStatus: PhoenixWebActionStatus;
  result: T;
};

type PhoenixByOrigin<T> = {
  watch?: T;
  hook?: T;
  manual?: T;
};

export type PhoenixOverviewReadModel = {
  schemaVersion: 1;
  generatedAt: string;
  latestAction?: PhoenixActionResult;
  latestByOrigin: PhoenixByOrigin<PhoenixActionResult>;
  latestBackup?: PhoenixLatestResult<PhoenixWebBackupResult>;
  latestHealth?: PhoenixLatestResult<PhoenixWebHealthResult>;
  latestRollback?: PhoenixLatestResult<PhoenixWebRollbackResult>;
  latestNotification?: PhoenixLatestResult<PhoenixWebNotificationResult>;
  latestRestore?: PhoenixLatestResult<PhoenixWebRestoreResult>;
  latestKnownGoodArchivePath?: string;
  lastBackupArchivePath?: string;
  archiveCount: number;
};

export type PhoenixTimelineReadModel = {
  schemaVersion: 1;
  generatedAt: string;
  entries: PhoenixActionResult[];
};

export type PhoenixOriginConfigSummary = PhoenixWebRunConfig & {
  lastRunAt?: string;
  installed?: boolean;
  eventKey?: string;
  hookDir?: string;
};

export type PhoenixConfigSummaryReadModel = {
  schemaVersion: 1;
  generatedAt: string;
  deployment?: {
    configPath: string;
    stateDir: string;
    oauthDir: string;
    warnings: string[];
  };
  origins: PhoenixByOrigin<PhoenixOriginConfigSummary>;
};

export type PhoenixArchiveRole = "latest-known-good" | "last-backup";

export type PhoenixArchiveSummaryItem = {
  archivePath: string;
  fileName: string;
  mtimeAt: string;
  sizeBytes: number;
  roles: PhoenixArchiveRole[];
};

export type PhoenixArchivesReadModel = {
  schemaVersion: 1;
  generatedAt: string;
  latestKnownGoodArchivePath?: string;
  lastBackupArchivePath?: string;
  archives: PhoenixArchiveSummaryItem[];
};

export type PhoenixWebSnapshot = {
  schemaVersion: 1;
  overview: PhoenixOverviewReadModel;
  timeline: PhoenixTimelineReadModel;
  config: PhoenixConfigSummaryReadModel;
  archives: PhoenixArchivesReadModel;
  setup: PhoenixSetupReadModel;
};

export type PhoenixSetupSection = "environment" | "backup" | "self-heal" | "notifications";
export type PhoenixSetupPriority = "required" | "optional" | "advanced";
export type PhoenixSetupSeverity = "ok" | "info" | "warning" | "blocker";
export type PhoenixSetupReadinessState = "ready" | "needs-attention" | "blocked";

export type PhoenixSetupItem = {
  id: string;
  section: PhoenixSetupSection;
  priority: PhoenixSetupPriority;
  severity: PhoenixSetupSeverity;
  title: string;
  summary: string;
  value?: string;
};

export type PhoenixSetupCommand = {
  id: string;
  title: string;
  summary: string;
  command: string;
  appliesChanges: false;
};

export type PhoenixSetupReadiness = {
  state: PhoenixSetupReadinessState;
  title: string;
  summary: string;
};

export type PhoenixSetupReadModel = {
  schemaVersion: 1;
  generatedAt: string;
  items: PhoenixSetupItem[];
  backupReadiness: PhoenixSetupReadiness;
  selfHealReadiness: PhoenixSetupReadiness;
  commands: PhoenixSetupCommand[];
};

function resolvePhoenixWebStatePath(outputDir: string): string {
  return path.join(outputDir, PHOENIX_WEB_STATE_FILENAME);
}

async function readPhoenixWebState(outputDir: string): Promise<PhoenixWebState> {
  const raw = await fs.readFile(resolvePhoenixWebStatePath(outputDir), "utf8").catch(() => null);
  if (!raw) {
    return { schemaVersion: 1, updatedAt: new Date(0).toISOString(), history: [] };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<PhoenixWebState>;
    return {
      schemaVersion: 1,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
      history: Array.isArray(parsed.history) ? parsed.history.filter(isPhoenixActionResult) : [],
    };
  } catch {
    return { schemaVersion: 1, updatedAt: new Date(0).toISOString(), history: [] };
  }
}

async function writePhoenixWebState(outputDir: string, state: PhoenixWebState): Promise<void> {
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(resolvePhoenixWebStatePath(outputDir), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function isPhoenixActionResult(value: unknown): value is PhoenixActionResult {
  return typeof value === "object" && value !== null && "id" in value && "finishedAt" in value && "origin" in value;
}

function summarizeNotificationConfig(notification: PhoenixNotificationConfig | undefined): PhoenixWebNotificationConfigSummary {
  if (!notification) {
    return { enabled: false, policy: "off", targetConfigured: false };
  }
  return {
    enabled: notification.enabled,
    policy: notification.enabled ? notification.policy : "off",
    target: notification.target,
    targetConfigured: Boolean(notification.target?.to),
  };
}

function summarizeNotificationResult(options: {
  events: PhoenixRecoveryNotificationEvent[];
  notification?: PhoenixNotificationConfig;
  delivery: PhoenixNotificationDispatch["results"];
}): PhoenixWebNotificationResult {
  if (options.delivery.some((entry) => !entry.delivered)) {
    return { events: options.events, delivery: options.delivery, status: "failed" };
  }
  if (options.delivery.some((entry) => entry.delivered)) {
    return { events: options.events, delivery: options.delivery, status: "delivered" };
  }
  if (options.events.length === 0) {
    return { events: options.events, delivery: options.delivery, status: "idle" };
  }
  if (!options.notification?.enabled) {
    return { events: options.events, delivery: options.delivery, status: "suppressed" };
  }
  if (!options.notification.target?.to) {
    return { events: options.events, delivery: options.delivery, status: "not-configured" };
  }
  return { events: options.events, delivery: options.delivery, status: "suppressed" };
}

function classifyRecoveryActionStatus(options: {
  ok: boolean;
  health: PhoenixWebHealthResult;
  backup: PhoenixWebBackupResult;
  rollback: PhoenixWebRollbackResult;
  notification: PhoenixWebNotificationResult;
}): PhoenixWebActionStatus {
  if (!options.ok) {
    return "error";
  }
  if (
    options.backup.error ||
    options.health.healthy === false ||
    options.rollback.restored ||
    options.notification.status === "failed"
  ) {
    return "warning";
  }
  return "ok";
}

function classifyBackupCycleStatus(backup: PhoenixWebBackupResult): PhoenixWebActionStatus {
  return backup.error ? "error" : "ok";
}

function toOriginLabel(origin: PhoenixWebOrigin): string {
  return origin === "hook" ? "Hook" : origin === "watch" ? "Watch" : "Manual";
}

function summarizeRecoveryAction(options: {
  origin: PhoenixWebOrigin;
  health: PhoenixWebHealthResult;
  knownGood: PhoenixWebKnownGoodResult;
  rollback: PhoenixWebRollbackResult;
  backup: PhoenixWebBackupResult;
}): string {
  const originLabel = toOriginLabel(options.origin);
  if (options.health.healthy) {
    if (options.knownGood.promotedArchivePath) {
      return `${originLabel} recovery promoted ${path.basename(options.knownGood.promotedArchivePath)} as latest known-good.`;
    }
    if (options.backup.archivePath) {
      return `${originLabel} recovery confirmed healthy status after ${path.basename(options.backup.archivePath)}.`;
    }
    return `${originLabel} recovery confirmed healthy status.`;
  }
  if (options.rollback.restored && options.rollback.archivePath) {
    return `${originLabel} recovery restored ${path.basename(options.rollback.archivePath)} after unhealthy status.`;
  }
  if (options.rollback.attempted && options.rollback.archivePath) {
    return `${originLabel} recovery failed to restore ${path.basename(options.rollback.archivePath)} after unhealthy status.`;
  }
  return `${originLabel} recovery detected unhealthy status with no known-good archive to restore.`;
}

function summarizeBackupCycleAction(backup: PhoenixWebBackupResult, retention: RetentionResult): string {
  if (backup.error) {
    return `Watch backup cycle failed: ${backup.error}`;
  }
  const deletedSuffix = retention.deleted.length > 0 ? ` Retention pruned ${retention.deleted.length} archive(s).` : "";
  return `Watch backup cycle created ${path.basename(backup.archivePath ?? "archive")}.${deletedSuffix}`.trim();
}

function summarizeRestoreAction(options: {
  dryRun: boolean;
  archivePath: string;
  restoredPaths: string[];
  error?: string;
}): string {
  if (options.error) {
    return `Manual restore failed for ${path.basename(options.archivePath)}: ${options.error}`;
  }
  if (options.dryRun) {
    return `Manual restore dry-run verified ${path.basename(options.archivePath)}.`;
  }
  return `Manual restore applied ${path.basename(options.archivePath)} to ${options.restoredPaths.length} path(s).`;
}

async function appendPhoenixAction(outputDir: string, action: PhoenixActionResult): Promise<PhoenixActionResult> {
  const state = await readPhoenixWebState(outputDir);
  state.updatedAt = action.finishedAt;
  state.history = [action, ...state.history].slice(0, MAX_PHOENIX_WEB_HISTORY);
  await writePhoenixWebState(outputDir, state);
  return action;
}

export async function recordPhoenixRecoveryAction(options: {
  origin: PhoenixWebOrigin;
  configPath?: string;
  outputDir: string;
  retain: number;
  selfHeal?: boolean;
  notification?: PhoenixNotificationConfig;
  startedAt: string;
  finishedAt: string;
  result: {
    ok: boolean;
    backup: PhoenixWebBackupResult;
    health: { healthy: boolean; reason: string };
    knownGood: PhoenixWebKnownGoodResult;
    rollback: PhoenixWebRollbackResult;
    retention: RetentionResult;
    notifications: PhoenixRecoveryNotificationEvent[];
    notificationDelivery: PhoenixNotificationDispatch;
  };
}): Promise<PhoenixActionResult> {
  const health: PhoenixWebHealthResult = {
    attempted: true,
    healthy: options.result.health.healthy,
    reason: options.result.health.reason,
  };
  const notification = summarizeNotificationResult({
    events: options.result.notifications,
    notification: options.notification,
    delivery: options.result.notificationDelivery.results,
  });
  const action: PhoenixActionResult = {
    schemaVersion: 1,
    id: randomUUID(),
    origin: options.origin,
    operation: "recovery-cycle",
    status: classifyRecoveryActionStatus({
      ok: options.result.ok,
      health,
      backup: options.result.backup,
      rollback: options.result.rollback,
      notification,
    }),
    startedAt: options.startedAt,
    finishedAt: options.finishedAt,
    summary: summarizeRecoveryAction({
      origin: options.origin,
      health,
      knownGood: options.result.knownGood,
      rollback: options.result.rollback,
      backup: options.result.backup,
    }),
    config: {
      configPath: options.configPath,
      outputDir: options.outputDir,
      retain: options.retain,
      selfHeal: options.selfHeal,
      notification: summarizeNotificationConfig(options.notification),
    },
    backup: options.result.backup,
    health,
    knownGood: options.result.knownGood,
    rollback: options.result.rollback,
    notification,
    retention: options.result.retention,
  };
  return appendPhoenixAction(options.outputDir, action);
}

export async function recordPhoenixBackupWatchAction(options: {
  configPath?: string;
  outputDir: string;
  retain: number;
  startedAt: string;
  finishedAt: string;
  backup: PhoenixWebBackupResult;
  retention: RetentionResult;
}): Promise<PhoenixActionResult> {
  const action: PhoenixActionResult = {
    schemaVersion: 1,
    id: randomUUID(),
    origin: "watch",
    operation: "backup-cycle",
    status: classifyBackupCycleStatus(options.backup),
    startedAt: options.startedAt,
    finishedAt: options.finishedAt,
    summary: summarizeBackupCycleAction(options.backup, options.retention),
    config: {
      configPath: options.configPath,
      outputDir: options.outputDir,
      retain: options.retain,
      selfHeal: false,
      notification: summarizeNotificationConfig(undefined),
    },
    backup: options.backup,
    retention: options.retention,
  };
  return appendPhoenixAction(options.outputDir, action);
}

export async function recordPhoenixRestoreAction(options: {
  origin?: PhoenixWebOrigin;
  configPath?: string;
  outputDir: string;
  dryRun: boolean;
  startedAt: string;
  finishedAt: string;
  archivePath: string;
  archiveRoot?: string;
  assetCount?: number;
  restoredPaths: string[];
  error?: string;
  verification?: {
    archiveRoot: string;
    createdAt: string;
    runtimeVersion: string;
    assetCount: number;
    entryCount: number;
  };
}): Promise<PhoenixActionResult> {
  const restore: PhoenixWebRestoreResult = {
    attempted: true,
    dryRun: options.dryRun,
    archivePath: options.archivePath,
    archiveRoot: options.archiveRoot,
    assetCount: options.assetCount,
    restoredPaths: options.restoredPaths,
    error: options.error,
    verification: options.verification,
  };
  const action: PhoenixActionResult = {
    schemaVersion: 1,
    id: randomUUID(),
    origin: options.origin ?? "manual",
    operation: "restore",
    status: options.error ? "error" : "ok",
    startedAt: options.startedAt,
    finishedAt: options.finishedAt,
    summary: summarizeRestoreAction({
      dryRun: options.dryRun,
      archivePath: options.archivePath,
      restoredPaths: options.restoredPaths,
      error: options.error,
    }),
    config: {
      configPath: options.configPath,
      outputDir: options.outputDir,
      dryRun: options.dryRun,
      notification: summarizeNotificationConfig(undefined),
    },
    restore,
  };
  return appendPhoenixAction(options.outputDir, action);
}

function findLatestByOrigin(entries: PhoenixActionResult[]): PhoenixByOrigin<PhoenixActionResult> {
  const latest: PhoenixByOrigin<PhoenixActionResult> = {};
  for (const entry of entries) {
    latest[entry.origin] ??= entry;
  }
  return latest;
}

function findLatestResult<T>(
  entries: PhoenixActionResult[],
  select: (entry: PhoenixActionResult) => T | undefined,
): PhoenixLatestResult<T> | undefined {
  for (const entry of entries) {
    const result = select(entry);
    if (result !== undefined) {
      return {
        operationId: entry.id,
        origin: entry.origin,
        finishedAt: entry.finishedAt,
        actionStatus: entry.status,
        result,
      };
    }
  }
  return undefined;
}

async function summarizeArchives(outputDir: string, latestKnownGoodArchivePath?: string, lastBackupArchivePath?: string) {
  const entries = await fs.readdir(outputDir, { withFileTypes: true }).catch(() => []);
  const archives = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(OPENCLAW_BACKUP_ARCHIVE_SUFFIX))
      .map(async (entry) => {
        const archivePath = path.join(outputDir, entry.name);
        const stat = await fs.stat(archivePath);
        const roles: PhoenixArchiveRole[] = [];
        if (latestKnownGoodArchivePath && normalizePathKey(archivePath) === normalizePathKey(latestKnownGoodArchivePath)) {
          roles.push("latest-known-good");
        }
        if (lastBackupArchivePath && normalizePathKey(archivePath) === normalizePathKey(lastBackupArchivePath)) {
          roles.push("last-backup");
        }
        return {
          archivePath,
          fileName: entry.name,
          mtimeAt: stat.mtime.toISOString(),
          sizeBytes: stat.size,
          roles,
        } satisfies PhoenixArchiveSummaryItem;
      }),
  );
  return archives.toSorted((left, right) => right.mtimeAt.localeCompare(left.mtimeAt));
}

async function pathStat(targetPath: string) {
  return fs.stat(targetPath).catch(() => null);
}

async function isWritable(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function findNearestExistingParent(targetPath: string): Promise<string | undefined> {
  let current = path.resolve(targetPath);
  for (;;) {
    const stat = await pathStat(current);
    if (stat) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function pickPrimaryOriginConfig(origins: PhoenixConfigSummaryReadModel["origins"]): PhoenixOriginConfigSummary | undefined {
  return origins.watch ?? origins.hook ?? origins.manual;
}

function pickNotificationOriginConfig(origins: PhoenixConfigSummaryReadModel["origins"]): PhoenixOriginConfigSummary | undefined {
  return origins.hook?.installed ? origins.hook : origins.watch?.selfHeal ? origins.watch : pickPrimaryOriginConfig(origins);
}

function pickRetainSetting(origins: PhoenixConfigSummaryReadModel["origins"]): { value: number; explicit: boolean } {
  const configured = [origins.watch?.retain, origins.hook?.retain, origins.manual?.retain].find((value) => value !== undefined);
  if (configured !== undefined) {
    return { value: configured, explicit: true };
  }
  return { value: DEFAULT_PHOENIX_RETAIN, explicit: false };
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@-]+$/u.test(value) ? value : JSON.stringify(value);
}

function buildWatchCommand(options: {
  configPath: string;
  outputDir: string;
  retain: number;
  selfHeal: boolean;
  notification?: PhoenixWebNotificationConfigSummary;
}): string {
  const parts = [
    "openclaw-phoenix",
    "watch",
    "--config",
    options.configPath,
    "--output",
    options.outputDir,
    "--retain",
    String(options.retain),
    "--notify",
    options.notification?.enabled ? options.notification.policy : "off",
  ];
  if (options.selfHeal) {
    parts.push("--self-heal");
  }
  if (options.notification?.target?.to) {
    parts.push("--notify-target", options.notification.target.to);
  }
  if (options.notification?.target?.channel) {
    parts.push("--notify-channel", options.notification.target.channel);
  }
  if (options.notification?.target?.accountId) {
    parts.push("--notify-account", options.notification.target.accountId);
  }
  if (options.notification?.target?.threadId) {
    parts.push("--notify-thread-id", options.notification.target.threadId);
  }
  return parts.map(shellQuote).join(" ");
}

async function buildPhoenixSetupReadModel(options: {
  generatedAt: string;
  outputDir: string;
  deployment?: PhoenixConfigSummaryReadModel["deployment"];
  origins: PhoenixConfigSummaryReadModel["origins"];
}): Promise<PhoenixSetupReadModel> {
  const items: PhoenixSetupItem[] = [];
  const addItem = (item: PhoenixSetupItem) => items.push(item);
  const deployment = options.deployment;
  const requiredConfigPath = deployment?.configPath;
  const requiredStateDir = deployment?.stateDir;
  const oauthDir = deployment?.oauthDir;
  const deploymentWarnings = deployment?.warnings ?? [];

  if (!requiredConfigPath) {
    addItem({
      id: "config-path",
      section: "environment",
      priority: "required",
      severity: "blocker",
      title: "OpenClaw config path",
      summary: "Phoenix could not resolve the deployment config yet. Point Phoenix at the active openclaw.json before relying on watch mode.",
    });
  } else {
    const configStat = await pathStat(requiredConfigPath);
    addItem(configStat?.isFile()
      ? {
          id: "config-path",
          section: "environment",
          priority: "required",
          severity: "ok",
          title: "OpenClaw config path",
          summary: "Phoenix can resolve the root deployment config for watch planning.",
          value: requiredConfigPath,
        }
      : {
          id: "config-path",
          section: "environment",
          priority: "required",
          severity: "blocker",
          title: "OpenClaw config path",
          summary: configStat
            ? "The resolved config path exists, but it is not a file. Phoenix expects the root openclaw.json here."
            : "Phoenix resolved a config path, but the file is not present yet.",
          value: requiredConfigPath,
        });
  }

  if (!requiredStateDir) {
    addItem({
      id: "state-dir",
      section: "environment",
      priority: "required",
      severity: "blocker",
      title: "OpenClaw state directory",
      summary: "Phoenix could not determine the deployment state directory.",
    });
  } else {
    const stateStat = await pathStat(requiredStateDir);
    addItem(stateStat?.isDirectory()
      ? {
          id: "state-dir",
          section: "environment",
          priority: "required",
          severity: "ok",
          title: "OpenClaw state directory",
          summary: "The deployment state directory is present for config, hooks, and agent state.",
          value: requiredStateDir,
        }
      : {
          id: "state-dir",
          section: "environment",
          priority: "required",
          severity: "blocker",
          title: "OpenClaw state directory",
          summary: stateStat
            ? "The resolved state path exists, but it is not a directory."
            : "Phoenix expects the OpenClaw state directory here, but it does not exist yet.",
          value: requiredStateDir,
        });
  }

  if (oauthDir) {
    const oauthStat = await pathStat(oauthDir);
    addItem(oauthStat?.isDirectory()
      ? {
          id: "oauth-dir",
          section: "environment",
          priority: "advanced",
          severity: "ok",
          title: "Credential store path",
          summary: "Phoenix can watch the current OpenClaw credential directory.",
          value: oauthDir,
        }
      : {
          id: "oauth-dir",
          section: "environment",
          priority: "advanced",
          severity: "info",
          title: "Credential store path",
          summary: "Phoenix knows where credentials should live. This path can appear later if OpenClaw has not created credentials yet.",
          value: oauthDir,
        });
  }

  addItem({
    id: "deployment-warnings",
    section: "environment",
    priority: "advanced",
    severity: deploymentWarnings.length > 0 ? "warning" : "ok",
    title: "Watch-plan warnings",
    summary: deploymentWarnings.length > 0
      ? deploymentWarnings.join(" ")
      : "No deployment-path warnings are currently recorded.",
  });

  const outputStat = await pathStat(options.outputDir);
  if (outputStat?.isDirectory()) {
    const writable = await isWritable(options.outputDir);
    addItem({
      id: "output-dir",
      section: "backup",
      priority: "required",
      severity: writable ? "ok" : "blocker",
      title: "Backup output directory",
      summary: writable
        ? "Phoenix can write archives into this directory."
        : "This directory exists, but the current user cannot write new backup archives here.",
      value: options.outputDir,
    });
  } else if (outputStat) {
    addItem({
      id: "output-dir",
      section: "backup",
      priority: "required",
      severity: "blocker",
      title: "Backup output directory",
      summary: "The configured output path exists, but it is not a directory.",
      value: options.outputDir,
    });
  } else {
    const parent = await findNearestExistingParent(options.outputDir);
    const parentWritable = parent ? await isWritable(parent) : false;
    addItem({
      id: "output-dir",
      section: "backup",
      priority: "required",
      severity: parentWritable ? "info" : "blocker",
      title: "Backup output directory",
      summary: parentWritable
        ? "Phoenix creates this directory automatically on the first backup or self-heal run."
        : "Phoenix can auto-create this directory only if an existing parent directory is writable.",
      value: options.outputDir,
    });
  }

  const retain = pickRetainSetting(options.origins);
  addItem(Number.isInteger(retain.value) && retain.value > 0
    ? {
        id: "retain-count",
        section: "backup",
        priority: "required",
        severity: retain.explicit ? "ok" : "info",
        title: "Retain count",
        summary: retain.explicit
          ? "Phoenix has a concrete retention count to keep recent archives."
          : `No explicit retain count has been observed yet, so Phoenix will use the default of ${DEFAULT_PHOENIX_RETAIN}.`,
        value: String(retain.value),
      }
    : {
        id: "retain-count",
        section: "backup",
        priority: "required",
        severity: "blocker",
        title: "Retain count",
        summary: "Phoenix requires a positive retain count.",
        value: String(retain.value),
      });

  const hookInstalled = options.origins.hook?.installed === true;
  const watchSelfHeal = options.origins.watch?.selfHeal === true;
  const selfHealActive = hookInstalled || watchSelfHeal;
  addItem(hookInstalled
    ? {
        id: "self-heal-mode",
        section: "self-heal",
        priority: "optional",
        severity: "ok",
        title: "Self-heal protection",
        summary: `The managed Phoenix hook is installed and can run backup, health, and rollback on ${options.origins.hook?.eventKey ?? DEFAULT_HOOK_EVENT}.`,
      }
    : watchSelfHeal
      ? {
          id: "self-heal-mode",
          section: "self-heal",
          priority: "optional",
          severity: "ok",
          title: "Self-heal protection",
          summary: "Phoenix has observed watch mode running with --self-heal enabled.",
        }
      : {
          id: "self-heal-mode",
          section: "self-heal",
          priority: "optional",
          severity: "info",
          title: "Self-heal protection",
          summary: options.origins.watch
            ? "Current watch settings are backup-only. Add --self-heal if you want automatic status checks and rollback after settled changes."
            : "Backup-only coverage can be ready without self-heal. Enable self-heal when you want Phoenix to validate health and roll back automatically.",
        });

  const notificationOrigin = pickNotificationOriginConfig(options.origins);
  const notification = notificationOrigin?.notification;
  addItem({
    id: "notification-mode",
    section: "notifications",
    priority: "optional",
    severity: !notification?.enabled
      ? "info"
      : selfHealActive
        ? "ok"
        : "warning",
    title: "Notification mode",
    summary: !notification?.enabled
      ? "Notifications are currently off. Phoenix can still protect locally without remote delivery."
      : selfHealActive
        ? `Phoenix will attempt ${notification.policy} notification delivery from the active self-heal flow.`
        : `Notification mode is ${notification.policy}, but Phoenix only sends notification summaries from self-heal runs.`,
    value: notification?.enabled ? notification.policy : "off",
  });

  addItem({
    id: "notification-target",
    section: "notifications",
    priority: "optional",
    severity: !notification?.enabled
      ? "info"
      : notification.targetConfigured
        ? "ok"
        : "warning",
    title: "Notification target",
    summary: !notification?.enabled
      ? "No remote target is required while notifications stay off."
      : notification.targetConfigured
        ? "Phoenix has a concrete delivery target for remote summaries."
        : "Notification mode is enabled, but --notify-target is missing, so remote delivery will be skipped.",
    value: notification?.target?.to,
  });

  const routingHints = [notification?.target?.channel, notification?.target?.accountId, notification?.target?.threadId].filter(Boolean);
  addItem({
    id: "notification-routing",
    section: "notifications",
    priority: "advanced",
    severity: routingHints.length > 0 ? "ok" : "info",
    title: "Advanced notification routing",
    summary: routingHints.length > 0
      ? "Channel, account, or thread hints are present for remote delivery."
      : "No advanced routing hints are configured. Phoenix will use only the target address if notifications are enabled.",
    value: routingHints.join(" • ") || undefined,
  });

  const requiredBlockers = items.filter((item) => item.priority === "required" && item.severity === "blocker").length;
  const warningCount = items.filter((item) => item.severity === "warning").length;
  const backupReadiness: PhoenixSetupReadiness = requiredBlockers > 0
    ? {
        state: "blocked",
        title: "Backup-only readiness is blocked",
        summary: "Resolve the required blockers before relying on Phoenix backup watch coverage.",
      }
    : warningCount > 0
      ? {
          state: "needs-attention",
          title: "Backup-only readiness has warnings",
          summary: "Backup-only coverage can run, but Phoenix has warnings you should review before calling the setup complete.",
        }
      : {
          state: "ready",
          title: "Backup-only readiness is clear",
          summary: "Phoenix has what it needs for minimal backup-only watch coverage.",
        };
  const selfHealReadiness: PhoenixSetupReadiness = requiredBlockers > 0
    ? {
        state: "blocked",
        title: "Self-heal readiness is blocked",
        summary: "Fix the required backup/setup blockers first, then enable or verify a self-heal path.",
      }
    : !selfHealActive
      ? {
          state: "needs-attention",
          title: "Self-heal readiness still needs setup",
          summary: "Backup-only coverage is available, but Phoenix is not yet set to run automatic health checks and rollback.",
        }
      : warningCount > 0
        ? {
            state: "needs-attention",
            title: "Self-heal readiness has warnings",
            summary: "Phoenix has a self-heal path, but you should review the remaining warnings before depending on it.",
          }
        : {
            state: "ready",
            title: "Self-heal readiness is clear",
            summary: "Phoenix has a visible self-heal path plus the required backup prerequisites.",
          };

  const configPathForCommand = requiredConfigPath ?? "<path-to-openclaw.json>";
  const primaryNotification = notificationOrigin?.notification;
  return {
    schemaVersion: PHOENIX_WEB_SCHEMA_VERSION,
    generatedAt: options.generatedAt,
    items,
    backupReadiness,
    selfHealReadiness,
    commands: [
      {
        id: "backup-watch",
        title: "Apply backup-only watch settings",
        summary: "Run Phoenix in minimal backup-only mode with the current output, retain, and notification settings shown on this page.",
        command: buildWatchCommand({
          configPath: configPathForCommand,
          outputDir: options.outputDir,
          retain: retain.value,
          selfHeal: false,
          notification: primaryNotification,
        }),
        appliesChanges: false,
      },
      {
        id: "self-heal-watch",
        title: "Apply watch self-heal settings",
        summary: hookInstalled
          ? "The hook already gives Phoenix startup self-heal. Use this command only if you also want watch-driven self-heal after local changes settle."
          : "Use this when you are ready to add automatic health checks and rollback to watch mode.",
        command: buildWatchCommand({
          configPath: configPathForCommand,
          outputDir: options.outputDir,
          retain: retain.value,
          selfHeal: true,
          notification: primaryNotification,
        }),
        appliesChanges: false,
      },
    ],
  };
}

async function resolveDeploymentSummary(options: {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  fallbackConfigPath?: string;
}): Promise<PhoenixConfigSummaryReadModel["deployment"] | undefined> {
  const configPath = options.configPath ?? options.fallbackConfigPath;
  if (!configPath && !options.env) {
    return undefined;
  }
  try {
    const plan = await resolveWatchPlan({ configPath, env: options.env });
    return {
      configPath: plan.rootConfigPath,
      stateDir: plan.stateDir,
      oauthDir: plan.oauthDir,
      warnings: plan.warnings,
    };
  } catch (error) {
    if (!configPath) {
      return undefined;
    }
    return {
      configPath,
      stateDir: "",
      oauthDir: "",
      warnings: [String(error)],
    };
  }
}

function originSummaryFromAction(action: PhoenixActionResult | undefined): PhoenixOriginConfigSummary | undefined {
  if (!action) {
    return undefined;
  }
  return {
    ...action.config,
    lastRunAt: action.finishedAt,
  };
}

function hookSummaryFromRecord(options: {
  record: PhoenixHookInstallRecord | null;
  hookDir?: string;
  existing?: PhoenixOriginConfigSummary;
  deployment?: PhoenixConfigSummaryReadModel["deployment"];
}): PhoenixOriginConfigSummary | undefined {
  if (!options.record && !options.existing) {
    return undefined;
  }
  return {
    configPath: options.existing?.configPath ?? options.deployment?.configPath,
    outputDir: options.existing?.outputDir ?? options.record?.outputDir ?? "",
    retain: options.existing?.retain ?? options.record?.retain,
    selfHeal: true,
    notification: options.existing?.notification ?? summarizeNotificationConfig(options.record?.notification),
    lastRunAt: options.existing?.lastRunAt,
    installed: Boolean(options.record),
    eventKey: options.record?.eventKey,
    hookDir: options.hookDir,
  };
}

export async function buildPhoenixWebSnapshot(options: {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  outputDir: string;
  timelineLimit?: number;
}): Promise<PhoenixWebSnapshot> {
  const generatedAt = new Date().toISOString();
  const [webState, recoveryState] = await Promise.all([
    readPhoenixWebState(options.outputDir),
    readPhoenixRecoveryState(options.outputDir),
  ]);
  const latestByOrigin = findLatestByOrigin(webState.history);
  const deployment = await resolveDeploymentSummary({
    configPath: options.configPath,
    env: options.env,
    fallbackConfigPath:
      latestByOrigin.watch?.config.configPath ?? latestByOrigin.hook?.config.configPath ?? latestByOrigin.manual?.config.configPath,
  });
  const hookDir = deployment?.stateDir ? resolvePhoenixHookDir(deployment.stateDir) : undefined;
  const hookRecord = hookDir ? await readPhoenixHookInstallRecord(hookDir) : null;
  const archives = await summarizeArchives(
    options.outputDir,
    recoveryState.latestKnownGoodArchivePath,
    recoveryState.lastBackupArchivePath,
  );
  const origins = {
    watch: originSummaryFromAction(latestByOrigin.watch),
    hook: hookSummaryFromRecord({
      record: hookRecord,
      hookDir,
      existing: originSummaryFromAction(latestByOrigin.hook),
      deployment,
    }),
    manual: originSummaryFromAction(latestByOrigin.manual),
  } satisfies PhoenixConfigSummaryReadModel["origins"];
  return {
    schemaVersion: PHOENIX_WEB_SCHEMA_VERSION,
    overview: {
      schemaVersion: PHOENIX_WEB_SCHEMA_VERSION,
      generatedAt,
      latestAction: webState.history[0],
      latestByOrigin,
      latestBackup: findLatestResult(webState.history, (entry) => entry.backup),
      latestHealth: findLatestResult(webState.history, (entry) => entry.health),
      latestRollback: findLatestResult(webState.history, (entry) => entry.rollback),
      latestNotification: findLatestResult(webState.history, (entry) => entry.notification),
      latestRestore: findLatestResult(webState.history, (entry) => entry.restore),
      latestKnownGoodArchivePath: recoveryState.latestKnownGoodArchivePath,
      lastBackupArchivePath: recoveryState.lastBackupArchivePath,
      archiveCount: archives.length,
    },
    timeline: {
      schemaVersion: PHOENIX_WEB_SCHEMA_VERSION,
      generatedAt,
      entries: webState.history.slice(0, options.timelineLimit ?? 20),
    },
    config: {
      schemaVersion: PHOENIX_WEB_SCHEMA_VERSION,
      generatedAt,
      deployment,
      origins,
    },
    archives: {
      schemaVersion: PHOENIX_WEB_SCHEMA_VERSION,
      generatedAt,
      latestKnownGoodArchivePath: recoveryState.latestKnownGoodArchivePath,
      lastBackupArchivePath: recoveryState.lastBackupArchivePath,
      archives,
    },
    setup: await buildPhoenixSetupReadModel({
      generatedAt,
      outputDir: options.outputDir,
      deployment,
      origins,
    }),
  };
}