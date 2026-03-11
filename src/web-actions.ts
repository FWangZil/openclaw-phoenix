import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { runOpenClawBackupCreate, runOpenClawStatus } from "./backup.js";
import { evaluateOpenClawStatusHealth } from "./health.js";
import { pruneBackupArchives } from "./retention.js";
import {
  recordPhoenixBackupAction,
  recordPhoenixHealthCheckAction,
  type PhoenixActionResult,
  type PhoenixWebActionStatus,
  type PhoenixWebActionTrigger,
} from "./web-contract.js";

export type PhoenixWebManualAction = "backup-now" | "health-check-now";

function manualActionTrigger(action: PhoenixWebManualAction): PhoenixWebActionTrigger {
  return { source: "web-console", request: action };
}

export type PhoenixWebActionState = {
  running?: {
    id: string;
    action: PhoenixWebManualAction;
    startedAt: string;
  };
  lastCompleted?: {
    id: string;
    action: PhoenixWebManualAction;
    startedAt: string;
    finishedAt: string;
    status: PhoenixWebActionStatus;
    summary: string;
    actionResult: PhoenixActionResult;
  };
};

export type PhoenixWebActionStartResult =
  | { ok: true; state: PhoenixWebActionState }
  | { ok: false; error: string; state: PhoenixWebActionState };

export type PhoenixWebActionController = {
  getState: () => PhoenixWebActionState;
  start: (action: PhoenixWebManualAction) => Promise<PhoenixWebActionStartResult>;
};

export type CreatePhoenixWebActionControllerOptions = {
  configPath?: string;
  openclawBin: string;
  outputDir: string;
  retain: number;
  env?: NodeJS.ProcessEnv;
};

async function runManualBackup(options: CreatePhoenixWebActionControllerOptions): Promise<PhoenixActionResult> {
  const startedAt = new Date().toISOString();
  const effectiveEnv = options.configPath
    ? { ...process.env, ...options.env, OPENCLAW_CONFIG_PATH: options.configPath }
    : (options.env ?? process.env);
  await fs.mkdir(options.outputDir, { recursive: true });
  try {
    const backup = await runOpenClawBackupCreate({
      openclawBin: options.openclawBin,
      outputDir: `${options.outputDir}${path.sep}`,
      env: effectiveEnv,
    });
    const retention = await pruneBackupArchives({
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
  let state: PhoenixWebActionState = {};

  const complete = (action: PhoenixWebManualAction, startedAt: string, result: PhoenixActionResult) => {
    state = {
      running: undefined,
      lastCompleted: {
        id: result.id,
        action,
        startedAt,
        finishedAt: result.finishedAt,
        status: result.status,
        summary: result.summary,
        actionResult: result,
      },
    };
  };

  return {
    getState: () => state,
    start: async (action) => {
      if (state.running) {
        return {
          ok: false,
          error: `Phoenix is already running ${state.running.action}. Wait for that action to finish before starting another one.`,
          state,
        };
      }
      const running = {
        id: randomUUID(),
        action,
        startedAt: new Date().toISOString(),
      };
      state = {
        ...state,
        running,
      };
      void (action === "backup-now" ? runManualBackup(options) : runManualHealthCheck(options))
        .then((result) => complete(action, running.startedAt, result))
        .catch((error) => {
          const failedAt = new Date().toISOString();
          state = {
            running: undefined,
            lastCompleted: {
              id: running.id,
              action,
              startedAt: running.startedAt,
              finishedAt: failedAt,
              status: "error",
              summary: String(error),
              actionResult: {
                schemaVersion: 1,
                id: running.id,
                origin: "manual",
                operation: action === "backup-now" ? "backup-cycle" : "health-check",
                status: "error",
                trigger: manualActionTrigger(action),
                startedAt: running.startedAt,
                finishedAt: failedAt,
                summary: String(error),
                config: {
                  configPath: options.configPath,
                  outputDir: options.outputDir,
                  retain: action === "backup-now" ? options.retain : undefined,
                  notification: { enabled: false, policy: "off", targetConfigured: false },
                },
              },
            },
          };
        });
      return { ok: true, state };
    },
  };
}