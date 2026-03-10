import { randomUUID } from "node:crypto";
import path from "node:path";
import { runOpenClawJsonCommand } from "./backup.js";

export type PhoenixNotificationMode = "off" | "exceptional-only" | "all";
export type PhoenixNotificationPolicy = Exclude<PhoenixNotificationMode, "off">;

export type PhoenixNotificationTarget = {
  to?: string;
  channel?: string;
  accountId?: string;
  threadId?: string;
};

export type PhoenixNotificationConfig = {
  enabled: boolean;
  policy: PhoenixNotificationPolicy;
  target?: PhoenixNotificationTarget;
};

export type PhoenixRecoveryNotificationEvent = {
  code: "healthy" | "rollback-failed" | "rollback-missing-known-good" | "rollback-restored";
  severity: "info" | "warning" | "error";
  message: string;
};

export type PhoenixNotificationDispatchResult = {
  event: PhoenixRecoveryNotificationEvent;
  attempted: boolean;
  delivered: boolean;
  error?: string;
};

export type PhoenixNotificationDispatch = {
  results: PhoenixNotificationDispatchResult[];
};

function trimOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeTarget(target: PhoenixNotificationTarget | undefined): PhoenixNotificationTarget | undefined {
  if (!target) {
    return undefined;
  }
  const normalized: PhoenixNotificationTarget = {
    to: trimOptionalString(target.to),
    channel: trimOptionalString(target.channel),
    accountId: trimOptionalString(target.accountId),
    threadId: trimOptionalString(target.threadId),
  };
  return normalized.to || normalized.channel || normalized.accountId || normalized.threadId
    ? normalized
    : undefined;
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function parsePhoenixNotificationMode(value: string): PhoenixNotificationMode {
  const normalized = value.trim().toLowerCase();
  if (normalized === "off" || normalized === "exceptional-only" || normalized === "all") {
    return normalized;
  }
  throw new Error(`notify mode must be one of off, exceptional-only, all (received ${value})`);
}

export function resolvePhoenixNotificationConfig(options: {
  mode?: PhoenixNotificationMode;
  target?: PhoenixNotificationTarget;
}): PhoenixNotificationConfig | undefined {
  const mode = options.mode ?? "off";
  const target = normalizeTarget(options.target);
  if (mode === "off" && !target) {
    return undefined;
  }
  return {
    enabled: mode !== "off",
    policy: mode === "all" ? "all" : "exceptional-only",
    target,
  };
}

export function buildHealthyNotificationEvent(options: {
  archivePath?: string;
  healthReason: string;
  promotedArchivePath?: string;
}): PhoenixRecoveryNotificationEvent {
  if (options.promotedArchivePath) {
    return {
      code: "healthy",
      severity: "info",
      message:
        `OpenClaw Phoenix confirmed healthy status (${options.healthReason}) and promoted ` +
        `${path.basename(options.promotedArchivePath)} as the latest known-good backup.`,
    };
  }
  if (options.archivePath) {
    return {
      code: "healthy",
      severity: "info",
      message:
        `OpenClaw Phoenix confirmed healthy status (${options.healthReason}) after backup ` +
        `${path.basename(options.archivePath)}.`,
    };
  }
  return {
    code: "healthy",
    severity: "info",
    message: `OpenClaw Phoenix confirmed healthy status (${options.healthReason}).`,
  };
}

export function selectPhoenixNotificationEvents(options: {
  backupArchivePath?: string;
  backupError?: string;
  health: {
    healthy: boolean;
    reason: string;
  };
  notification?: PhoenixNotificationConfig;
  notifications: PhoenixRecoveryNotificationEvent[];
  promotedArchivePath?: string;
}): PhoenixRecoveryNotificationEvent[] {
  if (options.notifications.length > 0) {
    return options.notifications;
  }
  if (
    options.notification?.policy === "all" &&
    options.health.healthy &&
    !options.backupError
  ) {
    return [
      buildHealthyNotificationEvent({
        archivePath: options.backupArchivePath,
        healthReason: options.health.reason,
        promotedArchivePath: options.promotedArchivePath,
      }),
    ];
  }
  return [];
}

export async function dispatchPhoenixNotifications(options: {
  env?: NodeJS.ProcessEnv;
  events: PhoenixRecoveryNotificationEvent[];
  notification?: PhoenixNotificationConfig;
  openclawBin: string;
}): Promise<PhoenixNotificationDispatch> {
  const target = normalizeTarget(options.notification?.target);
  const results: PhoenixNotificationDispatchResult[] = [];
  for (const event of options.events) {
    if (!options.notification?.enabled) {
      results.push({
        event,
        attempted: false,
        delivered: false,
      });
      continue;
    }
    if (!target?.to) {
      results.push({
        event,
        attempted: false,
        delivered: false,
        error: "notification target is not configured",
      });
      continue;
    }
    try {
      await runOpenClawJsonCommand({
        openclawBin: options.openclawBin,
        args: [
          "gateway",
          "call",
          "send",
          "--json",
          "--params",
          JSON.stringify({
            to: target.to,
            message: event.message,
            idempotencyKey: `phoenix-notify:${event.code}:${randomUUID()}`,
            ...(target.channel ? { channel: target.channel } : {}),
            ...(target.accountId ? { accountId: target.accountId } : {}),
            ...(target.threadId ? { threadId: target.threadId } : {}),
          }),
        ],
        env: options.env,
        label: `openclaw gateway call send (${event.code})`,
      });
      results.push({
        event,
        attempted: true,
        delivered: true,
      });
    } catch (error) {
      results.push({
        event,
        attempted: true,
        delivered: false,
        error: stringifyError(error),
      });
    }
  }
  return { results };
}
