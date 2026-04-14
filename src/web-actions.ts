import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { runOpenClawBackupCreateBatch, runOpenClawStatus } from "./backup.js";
import { evaluateOpenClawStatusHealth } from "./health.js";
import { DEFAULT_HOOK_EVENT, installPhoenixHook, removePhoenixHook, type HookInstallResult, type HookRemoveResult } from "./hook-install.js";
import { runPhoenixHook, type PhoenixHookRunResult } from "./hook-run.js";
import {
  type PhoenixNotificationConfig,
  type PhoenixNotificationMode,
  type PhoenixNotificationTarget,
  type PhoenixNotificationPolicy,
} from "./notify.js";
import { prunePhoenixBackupArchives } from "./retention.js";
import { startBackupWatch, type BackupWatchSession, type StartBackupWatchOptions } from "./watch.js";
import {
  recordPhoenixBackupAction,
  recordPhoenixHealthCheckAction,
  type PhoenixActionResult,
  type PhoenixWebActionStatus,
  type PhoenixWebSnapshot,
  type PhoenixWebActionTrigger,
} from "./web-contract.js";

export type PhoenixWebAction =
  | "backup-now"
  | "health-check-now"
  | "watch-start"
  | "watch-stop"
  | "hook-install"
  | "hook-remove"
  | "hook-run";

export type PhoenixWebNotificationOverride = {
  enabled: boolean;
  policy: PhoenixNotificationMode;
  target?: PhoenixNotificationTarget;
};

export type PhoenixWebActionPayloads = {
  "backup-now": undefined;
  "health-check-now": undefined;
  "watch-start": {
    selfHeal: boolean;
    notification?: PhoenixWebNotificationOverride;
  };
  "watch-stop": undefined;
  "hook-install": {
    eventKey: string;
    notification?: PhoenixWebNotificationOverride;
  };
  "hook-remove": undefined;
  "hook-run": {
    notification?: PhoenixWebNotificationOverride;
  };
};

export type PhoenixWebActionCapability = {
  enabled: boolean;
  reason?: string;
};

export type PhoenixWebWatchState = {
  status: "stopped" | "starting" | "running" | "stopping" | "error";
  startedAt?: string;
  stoppedAt?: string;
  selfHeal?: boolean;
  notification?: PhoenixWebNotificationOverride;
  lastError?: string;
};

export type PhoenixWebActionState = {
  runningMutation?: {
    id: string;
    action: PhoenixWebAction;
    startedAt: string;
  };
  lastCompleted?: {
    id: string;
    action: PhoenixWebAction;
    startedAt: string;
    finishedAt: string;
    status: PhoenixWebActionStatus;
    summary: string;
    actionResult?: PhoenixActionResult;
  };
  watch: PhoenixWebWatchState;
  capabilities: Record<PhoenixWebAction, PhoenixWebActionCapability>;
};

export type PhoenixWebActionStartResult =
  | { ok: true; state: PhoenixWebActionState }
  | { ok: false; status: number; error: string; state: PhoenixWebActionState };

export type PhoenixWebActionMetadata = {
  directMutations: true;
  watchLifecycle: "web-serve-process";
  defaultHookEvent: string;
  notificationOverridesSupported: true;
  watchExclusiveWhileRunning: true;
  context: {
    configPath?: string;
    openclawBin: string;
    outputDir: string;
    retain: number;
  };
};

export const DEFAULT_PHOENIX_WEB_ACTION_METADATA: Omit<PhoenixWebActionMetadata, "context"> = {
  directMutations: true,
  watchLifecycle: "web-serve-process",
  defaultHookEvent: DEFAULT_HOOK_EVENT,
  notificationOverridesSupported: true,
  watchExclusiveWhileRunning: true,
};

export type PhoenixWebActionController = {
  getState: () => Promise<PhoenixWebActionState>;
  start: <TAction extends PhoenixWebAction>(
    action: TAction,
    payload?: PhoenixWebActionPayloads[TAction],
  ) => Promise<PhoenixWebActionStartResult>;
  getActionMetadata: () => PhoenixWebActionMetadata;
  close?: () => Promise<void>;
};

type InstallHookInput = {
  configPath?: string;
  phoenixCommand: string[];
  openclawBin: string;
  outputDir: string;
  retain: number;
  notification?: PhoenixNotificationConfig;
  eventKey: string;
  env?: NodeJS.ProcessEnv;
};

type RunHookInput = {
  configPath?: string;
  openclawBin: string;
  outputDir: string;
  retain: number;
  env?: NodeJS.ProcessEnv;
  notification?: PhoenixNotificationConfig;
};

export type CreatePhoenixWebActionControllerOptions = {
  configPath?: string;
  openclawBin: string;
  outputDir: string;
  retain: number;
  env?: NodeJS.ProcessEnv;
  phoenixCommand?: string[];
  loadSnapshot: () => Promise<PhoenixWebSnapshot>;
  startWatch?: (options: StartBackupWatchOptions) => Promise<BackupWatchSession>;
  installHook?: (options: InstallHookInput) => Promise<HookInstallResult>;
  removeHook?: (options: { configPath?: string; env?: NodeJS.ProcessEnv }) => Promise<HookRemoveResult>;
  runHook?: (options: RunHookInput) => Promise<PhoenixHookRunResult>;
};

function manualActionTrigger(action: PhoenixWebAction): PhoenixWebActionTrigger {
  return { source: "web-console", request: action };
}

function trimOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeNotificationTarget(target: PhoenixNotificationTarget | undefined): PhoenixNotificationTarget | undefined {
  if (!target) {
    return undefined;
  }
  const normalized: PhoenixNotificationTarget = {
    to: trimOptionalString(target.to),
    channel: trimOptionalString(target.channel),
    accountId: trimOptionalString(target.accountId),
    threadId: trimOptionalString(target.threadId),
  };
  return normalized.to || normalized.channel || normalized.accountId || normalized.threadId ? normalized : undefined;
}

function normalizeNotificationOverride(
  input: PhoenixWebNotificationOverride | undefined,
): PhoenixWebNotificationOverride | undefined {
  if (!input) {
    return undefined;
  }
  const policy: PhoenixNotificationMode =
    input.enabled === false || input.policy === "off"
      ? "off"
      : input.policy === "all"
        ? "all"
        : "exceptional-only";
  return {
    enabled: policy !== "off",
    policy,
    target: normalizeNotificationTarget(input.target),
  };
}

function toNotificationConfig(
  input: PhoenixWebNotificationOverride | undefined,
): PhoenixNotificationConfig | undefined {
  const normalized = normalizeNotificationOverride(input);
  if (!normalized || normalized.policy === "off") {
    return undefined;
  }
  return {
    enabled: true,
    policy: normalized.policy as PhoenixNotificationPolicy,
    target: normalized.target,
  };
}

function buildEmptyCapabilities(reason: string): Record<PhoenixWebAction, PhoenixWebActionCapability> {
  return {
    "backup-now": { enabled: false, reason },
    "health-check-now": { enabled: false, reason },
    "watch-start": { enabled: false, reason },
    "watch-stop": { enabled: false, reason },
    "hook-install": { enabled: false, reason },
    "hook-remove": { enabled: false, reason },
    "hook-run": { enabled: false, reason },
  };
}

async function runManualBackup(options: CreatePhoenixWebActionControllerOptions): Promise<PhoenixActionResult> {
  const startedAt = new Date().toISOString();
  const effectiveEnv = options.configPath
    ? { ...process.env, ...options.env, OPENCLAW_CONFIG_PATH: options.configPath }
    : (options.env ?? process.env);
  await fs.mkdir(options.outputDir, { recursive: true });
  try {
    const backup = await runOpenClawBackupCreateBatch({
      openclawBin: options.openclawBin,
      outputDir: `${options.outputDir}${path.sep}`,
      env: effectiveEnv,
    });
    const retention = await prunePhoenixBackupArchives({
      directory: options.outputDir,
      retain: options.retain,
    });
    return recordPhoenixBackupAction({
      origin: "manual",
      trigger: manualActionTrigger("backup-now"),
      configPath: options.configPath,
      outputDir: options.outputDir,
      retain: options.retain,
      startedAt,
      finishedAt: new Date().toISOString(),
      backup: {
        attempted: true,
        archivePath: backup.archivePath,
        configOnlyArchivePath: backup.configOnlyArchivePath,
        error: backup.error,
      },
      retention,
    });
  } catch (error) {
    return recordPhoenixBackupAction({
      origin: "manual",
      trigger: manualActionTrigger("backup-now"),
      configPath: options.configPath,
      outputDir: options.outputDir,
      retain: options.retain,
      startedAt,
      finishedAt: new Date().toISOString(),
      backup: {
        attempted: true,
        error: String(error),
      },
      retention: { kept: [], deleted: [] },
    });
  }
}

async function runManualHealthCheck(options: CreatePhoenixWebActionControllerOptions): Promise<PhoenixActionResult> {
  const startedAt = new Date().toISOString();
  const effectiveEnv = options.configPath
    ? { ...process.env, ...options.env, OPENCLAW_CONFIG_PATH: options.configPath }
    : (options.env ?? process.env);
  try {
    const status = await runOpenClawStatus({
      openclawBin: options.openclawBin,
      env: effectiveEnv,
    });
    const health = evaluateOpenClawStatusHealth(status);
    return recordPhoenixHealthCheckAction({
      origin: "manual",
      trigger: manualActionTrigger("health-check-now"),
      configPath: options.configPath,
      outputDir: options.outputDir,
      startedAt,
      finishedAt: new Date().toISOString(),
      status: health.healthy ? "ok" : "warning",
      health: {
        attempted: true,
        healthy: health.healthy,
        reason: health.reason,
      },
    });
  } catch (error) {
    return recordPhoenixHealthCheckAction({
      origin: "manual",
      trigger: manualActionTrigger("health-check-now"),
      configPath: options.configPath,
      outputDir: options.outputDir,
      startedAt,
      finishedAt: new Date().toISOString(),
      status: "error",
      health: {
        attempted: true,
        healthy: false,
        reason: `status check failed: ${String(error)}`,
      },
    });
  }
}

export function createPhoenixWebActionController(
  options: CreatePhoenixWebActionControllerOptions,
): PhoenixWebActionController {
  const startWatchImpl = options.startWatch ?? startBackupWatch;
  const installHookImpl = options.installHook ?? installPhoenixHook;
  const removeHookImpl = options.removeHook ?? removePhoenixHook;
  const runHookImpl = options.runHook ?? runPhoenixHook;

  let runningMutation: PhoenixWebActionState["runningMutation"];
  let lastCompleted: PhoenixWebActionState["lastCompleted"];
  let watch: PhoenixWebWatchState = {
    status: "stopped",
  };
  let watchSession: BackupWatchSession | undefined;

  const metadata: PhoenixWebActionMetadata = {
    ...DEFAULT_PHOENIX_WEB_ACTION_METADATA,
    context: {
      configPath: options.configPath,
      openclawBin: options.openclawBin,
      outputDir: options.outputDir,
      retain: options.retain,
    },
  };

  const setLastCompleted = (entry: PhoenixWebActionState["lastCompleted"]) => {
    lastCompleted = entry;
  };

  const readSnapshot = async () => {
    try {
      return await options.loadSnapshot();
    } catch {
      return null;
    }
  };

  const buildCapabilities = (snapshot: PhoenixWebSnapshot | null): Record<PhoenixWebAction, PhoenixWebActionCapability> => {
    if (runningMutation) {
      return buildEmptyCapabilities(
        `Phoenix is already running ${runningMutation.action}. Wait for that action to finish before starting another one.`,
      );
    }
    if (watch.status === "running" || watch.status === "starting" || watch.status === "stopping") {
      return {
        ...buildEmptyCapabilities("Watch owns the runtime. Stop watch before starting another action."),
        "watch-stop": { enabled: true },
      };
    }
    if (!snapshot) {
      const capabilities = buildEmptyCapabilities("Phoenix could not load the current snapshot.");
      if (watch.status === "error") {
        capabilities["watch-start"] = { enabled: true };
      }
      return capabilities;
    }
    const selfHealBlocked = snapshot.setup.selfHealReadiness.state === "blocked";
    const backupBlocked = snapshot.setup.backupReadiness.state === "blocked";
    const hookInstalled = snapshot.config.origins.hook?.installed === true;
    return {
      "backup-now": { enabled: true },
      "health-check-now": { enabled: true },
      "watch-start": backupBlocked
        ? { enabled: false, reason: snapshot.setup.backupReadiness.title }
        : { enabled: true },
      "watch-stop": { enabled: false, reason: "Watch is not currently running." },
      "hook-install": selfHealBlocked
        ? { enabled: false, reason: snapshot.setup.selfHealReadiness.title }
        : { enabled: true },
      "hook-remove": hookInstalled
        ? { enabled: true }
        : { enabled: false, reason: "The managed Phoenix hook is not installed." },
      "hook-run": selfHealBlocked
        ? { enabled: false, reason: snapshot.setup.selfHealReadiness.title }
        : { enabled: true },
    };
  };

  const buildState = async (snapshot?: PhoenixWebSnapshot | null): Promise<PhoenixWebActionState> => {
    const effectiveSnapshot = snapshot === undefined ? await readSnapshot() : snapshot;
    return {
      runningMutation,
      lastCompleted,
      watch,
      capabilities: buildCapabilities(effectiveSnapshot),
    };
  };

  const reject = async (status: number, error: string, snapshot?: PhoenixWebSnapshot | null): Promise<PhoenixWebActionStartResult> => ({
    ok: false,
    status,
    error,
    state: await buildState(snapshot),
  });

  const beginForegroundMutation = (action: PhoenixWebAction) => {
    runningMutation = {
      id: randomUUID(),
      action,
      startedAt: new Date().toISOString(),
    };
    return runningMutation;
  };

  const finishForegroundMutation = (
    action: PhoenixWebAction,
    startedAt: string,
    status: PhoenixWebActionStatus,
    summary: string,
    actionResult?: PhoenixActionResult,
  ) => {
    const finishedAt = new Date().toISOString();
    runningMutation = undefined;
    setLastCompleted({
      id: actionResult?.id ?? randomUUID(),
      action,
      startedAt,
      finishedAt,
      status,
      summary,
      actionResult,
    });
  };

  const ensureActionAllowed = async <TAction extends PhoenixWebAction>(
    action: TAction,
    payload: PhoenixWebActionPayloads[TAction] | undefined,
  ): Promise<{ snapshot: PhoenixWebSnapshot | null } | PhoenixWebActionStartResult> => {
    const snapshot = await readSnapshot();
    const capabilities = buildCapabilities(snapshot);
    const capability = capabilities[action];
    if (!capability.enabled) {
      return reject(409, capability.reason ?? `Phoenix cannot run ${action} right now.`, snapshot);
    }
    if (!snapshot) {
      return reject(409, "Phoenix could not load the current snapshot.", snapshot);
    }
    if (action === "watch-start") {
      const watchPayload = payload as PhoenixWebActionPayloads["watch-start"] | undefined;
      if (watchPayload?.selfHeal && snapshot.setup.selfHealReadiness.state === "blocked") {
        return reject(409, snapshot.setup.selfHealReadiness.title, snapshot);
      }
      if (!watchPayload?.selfHeal && snapshot.setup.backupReadiness.state === "blocked") {
        return reject(409, snapshot.setup.backupReadiness.title, snapshot);
      }
    }
    if ((action === "hook-install" || action === "hook-run") && snapshot.setup.selfHealReadiness.state === "blocked") {
      return reject(409, snapshot.setup.selfHealReadiness.title, snapshot);
    }
    if (action === "hook-remove" && snapshot.config.origins.hook?.installed !== true) {
      return reject(409, "The managed Phoenix hook is not installed.", snapshot);
    }
    return { snapshot };
  };

  const syncWatchStopped = () => {
    watchSession = undefined;
    watch = {
      status: "stopped",
      stoppedAt: new Date().toISOString(),
      selfHeal: watch.selfHeal,
      notification: watch.notification,
      lastError: watch.lastError,
    };
  };

  return {
    getState: async () => buildState(),
    getActionMetadata: () => metadata,
    close: async () => {
      if (!watchSession) {
        return;
      }
      watch = {
        ...watch,
        status: "stopping",
      };
      const session = watchSession;
      watchSession = undefined;
      await session.close();
      await session.closed.catch(() => undefined);
      syncWatchStopped();
    },
    start: async (action, payload) => {
      const allowed = await ensureActionAllowed(action, payload);
      if ("ok" in allowed) {
        return allowed;
      }
      const { snapshot } = allowed;

      if (action === "backup-now" || action === "health-check-now") {
        const mutation = beginForegroundMutation(action);
        const startedState = await buildState(snapshot);
        void (action === "backup-now" ? runManualBackup(options) : runManualHealthCheck(options))
          .then((result) => {
            runningMutation = undefined;
            setLastCompleted({
              id: result.id,
              action,
              startedAt: mutation.startedAt,
              finishedAt: result.finishedAt,
              status: result.status,
              summary: result.summary,
              actionResult: result,
            });
          })
          .catch((error) => {
            finishForegroundMutation(action, mutation.startedAt, "error", String(error));
          });
        return { ok: true, state: startedState };
      }

      if (action === "watch-start") {
        const watchPayload = (payload as PhoenixWebActionPayloads["watch-start"] | undefined) ?? { selfHeal: false };
        const notification = normalizeNotificationOverride(watchPayload.notification);
        const startedAt = new Date().toISOString();
        watch = {
          status: "starting",
          startedAt,
          selfHeal: Boolean(watchPayload.selfHeal),
          notification,
        };
        try {
          const session = await startWatchImpl({
            configPath: options.configPath,
            env: options.env,
            openclawBin: options.openclawBin,
            outputDir: options.outputDir,
            retain: options.retain,
            selfHeal: Boolean(watchPayload.selfHeal),
            notification: toNotificationConfig(notification),
          });
          watchSession = session;
          watch = {
            status: "running",
            startedAt,
            selfHeal: Boolean(watchPayload.selfHeal),
            notification,
          };
          session.closed
            .then(() => {
              if (watchSession === session) {
                syncWatchStopped();
              }
            })
            .catch((error) => {
              watchSession = undefined;
              watch = {
                status: "error",
                stoppedAt: new Date().toISOString(),
                selfHeal: Boolean(watchPayload.selfHeal),
                notification,
                lastError: String(error),
              };
            });
          setLastCompleted({
            id: randomUUID(),
            action,
            startedAt,
            finishedAt: new Date().toISOString(),
            status: "ok",
            summary: `Watch started in ${watchPayload.selfHeal ? "self-heal" : "backup-only"} mode.`,
          });
          return { ok: true, state: await buildState(snapshot) };
        } catch (error) {
          watchSession = undefined;
          watch = {
            status: "error",
            stoppedAt: new Date().toISOString(),
            selfHeal: Boolean(watchPayload.selfHeal),
            notification,
            lastError: String(error),
          };
          setLastCompleted({
            id: randomUUID(),
            action,
            startedAt,
            finishedAt: new Date().toISOString(),
            status: "error",
            summary: String(error),
          });
          return reject(409, String(error), snapshot);
        }
      }

      if (action === "watch-stop") {
        if (!watchSession) {
          return reject(409, "Watch is not currently running.", snapshot);
        }
        const startedAt = new Date().toISOString();
        watch = {
          ...watch,
          status: "stopping",
        };
        const session = watchSession;
        watchSession = undefined;
        await session.close();
        await session.closed.catch(() => undefined);
        syncWatchStopped();
        setLastCompleted({
          id: randomUUID(),
          action,
          startedAt,
          finishedAt: new Date().toISOString(),
          status: "ok",
          summary: "Watch stopped.",
        });
        return { ok: true, state: await buildState(snapshot) };
      }

      const mutation = beginForegroundMutation(action);

      try {
        if (action === "hook-install") {
          const installPayload = (payload as PhoenixWebActionPayloads["hook-install"] | undefined) ?? {
            eventKey: DEFAULT_HOOK_EVENT,
          };
          if (!options.phoenixCommand?.length) {
            throw new Error("Phoenix could not resolve the current CLI entrypoint for hook install.");
          }
          const result = await installHookImpl({
            configPath: options.configPath,
            phoenixCommand: options.phoenixCommand,
            openclawBin: options.openclawBin,
            outputDir: options.outputDir,
            retain: options.retain,
            eventKey: trimOptionalString(installPayload.eventKey) ?? DEFAULT_HOOK_EVENT,
            notification: toNotificationConfig(installPayload.notification),
            env: options.env,
          });
          finishForegroundMutation(action, mutation.startedAt, "ok", `Installed Phoenix hook on ${result.eventKey}.`);
          return { ok: true, state: await buildState(snapshot) };
        }

        if (action === "hook-remove") {
          await removeHookImpl({
            configPath: options.configPath,
            env: options.env,
          });
          finishForegroundMutation(action, mutation.startedAt, "ok", "Removed the managed Phoenix hook.");
          return { ok: true, state: await buildState(snapshot) };
        }

        const runPayload = (payload as PhoenixWebActionPayloads["hook-run"] | undefined) ?? {};
        const result = await runHookImpl({
          configPath: options.configPath,
          openclawBin: options.openclawBin,
          outputDir: options.outputDir,
          retain: options.retain,
          env: options.env,
          notification: toNotificationConfig(runPayload.notification),
        });
        runningMutation = undefined;
        setLastCompleted({
          id: result.operation.id,
          action,
          startedAt: mutation.startedAt,
          finishedAt: result.operation.finishedAt,
          status: result.operation.status,
          summary: result.operation.summary,
          actionResult: result.operation,
        });
        return { ok: true, state: await buildState(snapshot) };
      } catch (error) {
        finishForegroundMutation(action, mutation.startedAt, "error", String(error));
        return reject(409, String(error), snapshot);
      }
    },
  };
}
