import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type {
  PhoenixActionResult,
  PhoenixArchiveSummaryItem,
  PhoenixConfigSummaryReadModel,
  PhoenixSetupItem,
  PhoenixSetupReadiness,
  PhoenixTimelineReadModel,
  PhoenixWebNotificationResult,
  PhoenixWebSnapshot,
} from "./web-contract.js";
import type { PhoenixWebActionController, PhoenixWebActionState, PhoenixWebManualAction } from "./web-actions.js";

export type PhoenixConsoleView = "overview" | "setup" | "activity" | "archives" | "configuration";

export type PhoenixWebConsoleServer = {
  url: string;
  close: () => Promise<void>;
  closed: Promise<void>;
};

export type StartPhoenixWebConsoleOptions = {
  host?: string;
  port?: number;
  actionController?: PhoenixWebActionController;
  loadSnapshot: () => Promise<PhoenixWebSnapshot>;
};

type Tone = "ok" | "warning" | "error" | "empty";
type KeyValueRow = { label: string; value?: string; tone?: Tone };
type LatestResult<T> = { origin: string; finishedAt: string; actionStatus: string; result: T };
type ProtectionStateLabel = "healthy" | "limited" | "degraded" | "failed" | "empty";
type ProtectionState = { tone: Tone; state: ProtectionStateLabel; title: string; detail: string };
type ExplanationCard = { tone: Tone; eyebrow: string; detail: string; rows: KeyValueRow[] };

const SNAPSHOT_POLL_INTERVAL_MS = 15_000;
const SNAPSHOT_STALE_AFTER_MS = 45_000;
const ACTION_OUTCOME_OLD_AFTER_MS = 10 * 60_000;

const VIEW_TITLES: Record<PhoenixConsoleView, string> = {
  overview: "Overview",
  setup: "Setup",
  activity: "Activity",
  archives: "Archives",
  configuration: "Configuration",
};

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatDateTime(value?: string): string {
  if (!value) {
    return "Not recorded yet";
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

function formatPath(value?: string): string {
  return value ? `<code>${escapeHtml(value)}</code>` : '<span class="muted">Not available yet</span>';
}

function formatBoolean(value: boolean | undefined, truthy = "Yes", falsy = "No"): string {
  return value === undefined ? "Unknown" : value ? truthy : falsy;
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 ** 2) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  if (value < 1024 ** 3) {
    return `${(value / 1024 ** 2).toFixed(1)} MB`;
  }
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
}

function formatDuration(value: number): string {
  if (value < 1_000) {
    return "under 1 second";
  }
  if (value < 60_000) {
    return `${Math.round(value / 1_000)} second(s)`;
  }
  if (value < 3_600_000) {
    return `${Math.round(value / 60_000)} minute(s)`;
  }
  if (value < 86_400_000) {
    return `${Math.round(value / 3_600_000)} hour(s)`;
  }
  return `${Math.round(value / 86_400_000)} day(s)`;
}

function formatGap(later?: string, earlier?: string): string {
  if (!later || !earlier) {
    return "Not available yet";
  }
  const laterMs = new Date(later).getTime();
  const earlierMs = new Date(earlier).getTime();
  if (Number.isNaN(laterMs) || Number.isNaN(earlierMs)) {
    return "Not available yet";
  }
  return formatDuration(Math.abs(laterMs - earlierMs));
}

function basenameOrFallback(filePath: string | undefined, fallback: string): string {
  return filePath ? path.basename(filePath) : fallback;
}

function operationLabel(operation: PhoenixActionResult["operation"]): string {
  return operation === "backup-cycle"
    ? "Backup cycle"
    : operation === "recovery-cycle"
      ? "Recovery cycle"
      : operation === "health-check"
        ? "Health check"
        : "Manual restore";
}

function manualActionLabel(action: PhoenixWebManualAction): string {
  return action === "backup-now" ? "Backup now" : "Health check now";
}

function protectionStateLabel(state: ProtectionStateLabel): string {
  return state === "healthy"
    ? "Healthy"
    : state === "limited"
      ? "Limited"
      : state === "degraded"
        ? "Degraded"
        : state === "failed"
          ? "Failed"
          : "No data yet";
}

function normalizeView(pathname: string): PhoenixConsoleView | undefined {
  const normalized = pathname === "/" ? "/overview" : pathname.replace(/\/+$/u, "") || "/overview";
  switch (normalized) {
    case "/overview":
      return "overview";
    case "/setup":
      return "setup";
    case "/activity":
      return "activity";
    case "/archives":
      return "archives";
    case "/configuration":
      return "configuration";
    default:
      return undefined;
  }
}

function statusBadge(label: string, tone: Tone): string {
  return `<span class="badge badge--${tone}">${escapeHtml(label)}</span>`;
}

function originBadge(origin: string): string {
  return `<span class="badge badge--origin">${escapeHtml(origin === "hook" ? "Hook" : origin === "watch" ? "Watch" : "Manual")}</span>`;
}

function toneForActionStatus(status: string | undefined): Tone {
  if (status === "error") {
    return "error";
  }
  if (status === "warning") {
    return "warning";
  }
  if (status === "ok") {
    return "ok";
  }
  return "empty";
}

function toneForSetupSeverity(severity: PhoenixSetupItem["severity"]): Tone {
  if (severity === "blocker") {
    return "error";
  }
  if (severity === "warning") {
    return "warning";
  }
  if (severity === "ok") {
    return "ok";
  }
  return "empty";
}

function toneForReadiness(state: PhoenixSetupReadiness["state"]): Tone {
  if (state === "blocked") {
    return "error";
  }
  if (state === "needs-attention") {
    return "warning";
  }
  return "ok";
}

function setupSectionLabel(section: PhoenixSetupItem["section"]): string {
  return section === "self-heal"
    ? "Self-heal"
    : section === "notifications"
      ? "Notifications"
      : section === "backup"
        ? "Backup"
        : "Environment";
}

function setupPriorityLabel(priority: PhoenixSetupItem["priority"]): string {
  return priority === "required" ? "Required" : priority === "optional" ? "Optional" : "Advanced";
}

function setupSeverityLabel(severity: PhoenixSetupItem["severity"]): string {
  return severity === "blocker"
    ? "Hard blocker"
    : severity === "warning"
      ? "Soft warning"
      : severity === "info"
        ? "Info"
        : "Ready";
}

function watchModeLabel(config: PhoenixConfigSummaryReadModel["origins"]["watch"]): string {
  if (!config) {
    return "Not observed yet";
  }
  return config.selfHeal ? "Self-heal enabled" : "Backup-only";
}

function hookModeLabel(config: PhoenixConfigSummaryReadModel["origins"]["hook"]): string {
  if (!config) {
    return "Not installed";
  }
  return config.installed ? "Installed (self-heal)" : "History only";
}

function deriveProtectionState(snapshot: PhoenixWebSnapshot): ProtectionState {
  const warnings = snapshot.config.deployment?.warnings ?? [];
  const latestAction = snapshot.overview.latestAction;
  const latestHealth = snapshot.overview.latestHealth?.result;
  const latestRollback = snapshot.overview.latestRollback?.result;
  const latestNotification = snapshot.overview.latestNotification?.result;
  const hookInstalled = snapshot.config.origins.hook?.installed === true;
  const watchConfig = snapshot.config.origins.watch;
  const selfHealEnabled = hookInstalled || watchConfig?.selfHeal === true;
  const healthReason = latestHealth?.reason ? ` (${latestHealth.reason})` : "";

  if (!latestAction && !hookInstalled && !watchConfig && snapshot.archives.archives.length === 0) {
    return {
      tone: "empty",
      state: "empty",
      title: "No Phoenix protection state recorded yet",
      detail: "This read-only console has no watch, hook, or archive activity to summarize yet.",
    };
  }

  if (latestHealth?.healthy === false) {
    if (latestRollback?.restored) {
      return {
        tone: "warning",
        state: "degraded",
        title: "Phoenix currently looks degraded",
        detail:
          `Phoenix detected an unhealthy result${healthReason} and restored ` +
          `${basenameOrFallback(latestRollback.archivePath, "the latest known-good archive")}. ` +
          "Recovery worked, but the newest change did not stay live.",
      };
    }
    if (latestRollback?.attempted) {
      return {
        tone: "error",
        state: "failed",
        title: "Phoenix currently looks failed",
        detail:
          `Phoenix detected an unhealthy result${healthReason} and rollback failed` +
          `${latestRollback.archivePath ? ` while restoring ${basenameOrFallback(latestRollback.archivePath, "the archive")}` : ""}.` +
          `${latestRollback.error ? ` ${latestRollback.error}` : ""}`,
      };
    }
    if (latestRollback?.needed) {
      return {
        tone: "error",
        state: "failed",
        title: "Phoenix currently looks failed",
        detail: `Phoenix detected an unhealthy result${healthReason}, but no known-good archive was available to restore.`,
      };
    }
  }

  if (latestAction?.status === "error") {
    return {
      tone: "error",
      state: "failed",
      title: "Phoenix currently looks failed",
      detail: latestAction.summary,
    };
  }

  if (latestNotification?.status === "failed") {
    return {
      tone: "warning",
      state: "degraded",
      title: "Phoenix currently looks degraded",
      detail: "Phoenix kept local state, but the latest notification delivery failed. Remote operators may not have seen the most recent outcome.",
    };
  }

  if (warnings.length > 0 || latestAction?.status === "warning") {
    return {
      tone: "warning",
      state: "degraded",
      title: "Phoenix currently looks degraded",
      detail: warnings.length > 0
        ? `Phoenix reported ${warnings.length} deployment warning(s). Review the configuration summary before treating this state as fully healthy.`
        : latestAction?.summary ?? "Phoenix recorded a warning outcome in the latest run.",
    };
  }

  if (selfHealEnabled) {
    return {
      tone: "ok",
      state: "healthy",
      title: "Phoenix currently looks healthy",
      detail: latestHealth?.healthy
        ? `The latest recovery check stayed healthy${healthReason}, and Phoenix still has a known-good recovery point available.`
        : hookInstalled
          ? "The managed Phoenix hook is installed, and Phoenix has not recorded a newer warning or failure since the last snapshot."
          : "Watch self-heal is enabled, and Phoenix has not recorded a newer warning or failure since the last snapshot.",
    };
  }

  if (watchConfig) {
    return {
      tone: "warning",
      state: "limited",
      title: "Phoenix currently looks limited",
      detail: "Phoenix is recording change-driven backups, but this visible watch configuration does not automatically health-check or roll back the live state.",
    };
  }

  return {
    tone: "warning",
    state: "limited",
    title: "Phoenix currently looks limited",
    detail: "Phoenix has history or archives, but no current hook install or watch configuration is visible in this snapshot.",
  };
}

function findActionByOperationId(snapshot: PhoenixWebSnapshot, operationId: string | undefined): PhoenixActionResult | undefined {
  if (!operationId) {
    return undefined;
  }
  return snapshot.timeline.entries.find((entry) => entry.id === operationId) ?? (snapshot.overview.latestAction?.id === operationId ? snapshot.overview.latestAction : undefined);
}

function buildMeaningfulOutcomeExplanation(snapshot: PhoenixWebSnapshot, protection: ProtectionState): ExplanationCard | undefined {
  const latestAction = snapshot.overview.latestAction;
  const latestHealth = snapshot.overview.latestHealth;
  if (!latestAction) {
    return undefined;
  }

  let detail = latestAction.summary;
  if (latestAction.operation === "recovery-cycle" && latestAction.health?.healthy) {
    detail = latestAction.knownGood?.promotedArchivePath
      ? `Phoenix looks healthy because the latest recovery check stayed healthy (${latestAction.health.reason}) and promoted ${basenameOrFallback(latestAction.knownGood.promotedArchivePath, "the newest archive")} as the current known-good recovery point.`
      : `Phoenix looks healthy because the latest recovery check stayed healthy (${latestAction.health.reason}). No rollback was needed.`;
  } else if (latestAction.operation === "recovery-cycle" && latestAction.health?.healthy === false) {
    if (latestAction.rollback?.restored) {
      detail = `Phoenix looks degraded because the latest recovery check turned unhealthy (${latestAction.health.reason}), so Phoenix restored ${basenameOrFallback(latestAction.rollback.archivePath, "the latest known-good archive")}. Recovery worked, but the last change was rolled back.`;
    } else if (latestAction.rollback?.attempted) {
      detail = `Phoenix looks failed because the latest recovery check turned unhealthy (${latestAction.health.reason}) and the rollback attempt failed${latestAction.rollback.error ? `: ${latestAction.rollback.error}` : "."}`;
    } else {
      detail = `Phoenix looks failed because the latest recovery check turned unhealthy (${latestAction.health.reason}) and Phoenix had no known-good archive to restore.`;
    }
  } else if (latestAction.operation === "backup-cycle") {
    detail = latestAction.backup?.archivePath
      ? `Phoenix most recently created ${basenameOrFallback(latestAction.backup.archivePath, "a backup archive")}. That gives you a recovery point, but this backup-only cycle did not prove the live system was healthy.`
      : latestAction.summary;
    if (latestHealth && latestHealth.operationId !== latestAction.id) {
      detail += ` The newest health verdict is still from ${formatDateTime(latestHealth.finishedAt)}, when Phoenix reported ${latestHealth.result.healthy ? "healthy" : "unhealthy"} status${latestHealth.result.reason ? ` (${latestHealth.result.reason})` : ""}.`;
    }
  } else if (latestAction.operation === "health-check") {
    detail = latestAction.health?.healthy
      ? `Phoenix most recently ran a manual health check and the deployment reported healthy status${latestAction.health.reason ? ` (${latestAction.health.reason})` : ""}. This browser action did not create a backup or roll back live state.`
      : `Phoenix most recently ran a manual health check and the deployment reported unhealthy status${latestAction.health?.reason ? ` (${latestAction.health.reason})` : ""}. This browser action recorded the result only; it did not restore live state.`;
  } else if (latestAction.operation === "restore") {
    detail = latestAction.restore?.error
      ? `Phoenix most recently attempted a manual restore, but it failed for ${basenameOrFallback(latestAction.restore.archivePath, "the selected archive")}: ${latestAction.restore.error}`
      : latestAction.restore?.dryRun
        ? `Phoenix most recently ran a manual restore dry-run for ${basenameOrFallback(latestAction.restore.archivePath, "the selected archive")}. The browser preview stayed read-only; no files were written by the console itself.`
        : `Phoenix most recently applied ${basenameOrFallback(latestAction.restore?.archivePath, "the selected archive")} through a manual restore.`;
  }

  return {
    tone: protection.tone,
    eyebrow: `${protectionStateLabel(protection.state)} outcome`,
    detail,
    rows: [
      { label: "Current state", value: statusBadge(protectionStateLabel(protection.state), protection.tone) },
      { label: "Latest event", value: `${originBadge(latestAction.origin)}<span class="badge badge--muted">${escapeHtml(operationLabel(latestAction.operation))}</span>` },
      { label: "Finished", value: escapeHtml(formatDateTime(latestAction.finishedAt)) },
      {
        label: "Latest health verdict",
        value: latestHealth
          ? escapeHtml(`${latestHealth.result.healthy ? "Healthy" : "Unhealthy"}${latestHealth.result.reason ? ` • ${latestHealth.result.reason}` : ""}`)
          : "No health verdict recorded",
        tone: latestHealth ? (latestHealth.result.healthy ? "ok" : "error") : "empty",
      },
    ],
  };
}

function buildRollbackExplanation(snapshot: PhoenixWebSnapshot): ExplanationCard | undefined {
  const latest = snapshot.overview.latestRollback;
  if (!latest) {
    return undefined;
  }
  const relatedAction = findActionByOperationId(snapshot, latest.operationId);
  const healthReason = relatedAction?.health?.reason;
  if (latest.result.restored) {
    return {
      tone: "warning",
      eyebrow: "Rollback happened",
      detail: `Rollback happened because Phoenix saw an unhealthy result${healthReason ? ` (${healthReason})` : ""} and restored ${basenameOrFallback(latest.result.archivePath, "the latest known-good archive")}. The service recovered, but the newest change was rejected.`,
      rows: [
        { label: "Origin", value: originBadge(latest.origin) },
        { label: "Finished", value: escapeHtml(formatDateTime(latest.finishedAt)) },
        { label: "Outcome", value: statusBadge("Restored", "warning") },
        { label: "Archive", value: formatPath(latest.result.archivePath) },
      ],
    };
  }
  if (latest.result.needed && latest.result.attempted) {
    return {
      tone: "error",
      eyebrow: "Rollback failed",
      detail: `Rollback failed because Phoenix tried to restore ${basenameOrFallback(latest.result.archivePath, "the known-good archive")} after an unhealthy result${healthReason ? ` (${healthReason})` : ""}${latest.result.error ? `: ${latest.result.error}` : "."}`,
      rows: [
        { label: "Origin", value: originBadge(latest.origin) },
        { label: "Finished", value: escapeHtml(formatDateTime(latest.finishedAt)) },
        { label: "Outcome", value: statusBadge("Failed", "error") },
        { label: "Archive", value: formatPath(latest.result.archivePath) },
        { label: "Error", value: latest.result.error ? escapeHtml(latest.result.error) : "No error recorded", tone: "error" },
      ],
    };
  }
  if (latest.result.needed) {
    return {
      tone: "error",
      eyebrow: "Rollback skipped",
      detail: `Rollback was skipped because Phoenix saw an unhealthy result${healthReason ? ` (${healthReason})` : ""}, but no known-good archive was available to restore.`,
      rows: [
        { label: "Origin", value: originBadge(latest.origin) },
        { label: "Finished", value: escapeHtml(formatDateTime(latest.finishedAt)) },
        { label: "Outcome", value: statusBadge("No known-good archive", "error") },
        { label: "Archive", value: formatPath(latest.result.archivePath) },
      ],
    };
  }
  return {
    tone: "ok",
    eyebrow: "Rollback skipped",
    detail: `Rollback was skipped because Phoenix's latest health check stayed healthy${healthReason ? ` (${healthReason})` : ""}. There was nothing to undo.`,
    rows: [
      { label: "Origin", value: originBadge(latest.origin) },
      { label: "Finished", value: escapeHtml(formatDateTime(latest.finishedAt)) },
      { label: "Outcome", value: statusBadge("Not needed", "ok") },
      { label: "Archive", value: formatPath(latest.result.archivePath) },
    ],
  };
}

function buildNotificationExplanation(snapshot: PhoenixWebSnapshot): ExplanationCard | undefined {
  const latest = snapshot.overview.latestNotification;
  if (!latest) {
    return undefined;
  }
  const relatedAction = findActionByOperationId(snapshot, latest.operationId);
  const firstEvent = latest.result.events[0]?.message;
  const firstError = latest.result.delivery.find((entry) => !entry.delivered)?.error;

  switch (latest.result.status) {
    case "delivered":
      return {
        tone: "ok",
        eyebrow: "Notification attempted",
        detail: firstEvent
          ? `Phoenix attempted notifications for the latest recovery outcome and delivery succeeded. First message: ${firstEvent}`
          : "Phoenix attempted notifications for the latest recovery outcome and delivery succeeded.",
        rows: [
          { label: "Origin", value: originBadge(latest.origin) },
          { label: "Finished", value: escapeHtml(formatDateTime(latest.finishedAt)) },
          { label: "Outcome", value: statusBadge("Delivered", "ok") },
          { label: "Events", value: escapeHtml(String(latest.result.events.length)) },
          { label: "Attempts", value: escapeHtml(String(latest.result.delivery.length)) },
        ],
      };
    case "failed":
      return {
        tone: "warning",
        eyebrow: "Notification failed",
        detail: `Phoenix attempted to send the latest recovery notification, but delivery failed${firstError ? `: ${firstError}` : "."} The local Phoenix result still recorded, but remote operators may not have seen it.`,
        rows: [
          { label: "Origin", value: originBadge(latest.origin) },
          { label: "Finished", value: escapeHtml(formatDateTime(latest.finishedAt)) },
          { label: "Outcome", value: statusBadge("Delivery failed", "warning") },
          { label: "Events", value: escapeHtml(String(latest.result.events.length)) },
          { label: "Attempts", value: escapeHtml(String(latest.result.delivery.length)) },
          { label: "Error", value: firstError ? escapeHtml(firstError) : "No error recorded", tone: "warning" },
        ],
      };
    case "not-configured":
      return {
        tone: "warning",
        eyebrow: "Notification skipped",
        detail: "Phoenix had something worth sending, but notification delivery was skipped because no destination target was configured.",
        rows: [
          { label: "Origin", value: originBadge(latest.origin) },
          { label: "Finished", value: escapeHtml(formatDateTime(latest.finishedAt)) },
          { label: "Outcome", value: statusBadge("Target missing", "warning") },
          { label: "Events", value: escapeHtml(String(latest.result.events.length)) },
          { label: "Configured target", value: escapeHtml(formatBoolean(relatedAction?.config.notification.targetConfigured)) },
        ],
      };
    case "suppressed":
      return {
        tone: "warning",
        eyebrow: "Notification skipped",
        detail: "Phoenix produced a notification-worthy outcome, but notifications were turned off for that run, so nothing was sent remotely.",
        rows: [
          { label: "Origin", value: originBadge(latest.origin) },
          { label: "Finished", value: escapeHtml(formatDateTime(latest.finishedAt)) },
          { label: "Outcome", value: statusBadge("Suppressed", "warning") },
          { label: "Events", value: escapeHtml(String(latest.result.events.length)) },
          { label: "Policy", value: escapeHtml(relatedAction?.config.notification.policy ?? "off") },
        ],
      };
    case "idle":
    default:
      return {
        tone: "ok",
        eyebrow: "Notification skipped",
        detail: "Phoenix did not attempt notifications because the latest structured outcome did not require one under the current policy. Backup-only watch runs also do not send recovery notifications.",
        rows: [
          { label: "Origin", value: originBadge(latest.origin) },
          { label: "Finished", value: escapeHtml(formatDateTime(latest.finishedAt)) },
          { label: "Outcome", value: statusBadge("Nothing to send", "ok") },
          { label: "Events", value: escapeHtml(String(latest.result.events.length)) },
          { label: "Policy", value: escapeHtml(relatedAction?.config.notification.policy ?? "off") },
        ],
      };
  }
}

function buildFreshnessExplanation(snapshot: PhoenixWebSnapshot): ExplanationCard {
  const latestAction = snapshot.overview.latestAction;
  const outcomeAge = formatGap(snapshot.overview.generatedAt, latestAction?.finishedAt);
  const outcomeAgeMs = latestAction
    ? Math.abs(new Date(snapshot.overview.generatedAt).getTime() - new Date(latestAction.finishedAt).getTime())
    : undefined;
  const aging = outcomeAgeMs !== undefined && !Number.isNaN(outcomeAgeMs) && outcomeAgeMs > ACTION_OUTCOME_OLD_AFTER_MS;

  return latestAction
    ? {
        tone: aging ? "warning" : "ok",
        eyebrow: aging ? "Aging data" : "Fresh snapshot",
        detail: aging
          ? `Phoenix generated this snapshot at ${formatDateTime(snapshot.overview.generatedAt)}, but the latest recorded outcome is already ${outcomeAge} older. Phoenix may simply have been idle, but this console does not claim anything newer until another snapshot is produced. Browser checks warn if the page stops receiving fresh data.`
          : `Phoenix generated this snapshot at ${formatDateTime(snapshot.overview.generatedAt)}. Browser checks look for newer data every ${formatDuration(SNAPSHOT_POLL_INTERVAL_MS)} and warn if that stops working for ${formatDuration(SNAPSHOT_STALE_AFTER_MS)}.`,
        rows: [
          { label: "Snapshot generated", value: escapeHtml(formatDateTime(snapshot.overview.generatedAt)) },
          { label: "Latest recorded outcome", value: escapeHtml(formatDateTime(latestAction.finishedAt)) },
          { label: "Outcome age at snapshot time", value: escapeHtml(outcomeAge), tone: aging ? "warning" : "ok" },
          { label: "Browser polling", value: escapeHtml(`Every ${formatDuration(SNAPSHOT_POLL_INTERVAL_MS)}`) },
          { label: "Stale warning", value: escapeHtml(`After ${formatDuration(SNAPSHOT_STALE_AFTER_MS)} without a successful browser refresh check`) },
        ],
      }
    : {
        tone: "empty",
        eyebrow: "Setup state",
        detail: `Phoenix generated this snapshot at ${formatDateTime(snapshot.overview.generatedAt)}, but no meaningful outcome has been recorded yet. Browser checks still look for newer data every ${formatDuration(SNAPSHOT_POLL_INTERVAL_MS)}.`,
        rows: [
          { label: "Snapshot generated", value: escapeHtml(formatDateTime(snapshot.overview.generatedAt)) },
          { label: "Latest recorded outcome", value: "Not recorded yet" },
          { label: "Browser polling", value: escapeHtml(`Every ${formatDuration(SNAPSHOT_POLL_INTERVAL_MS)}`) },
          { label: "Stale warning", value: escapeHtml(`After ${formatDuration(SNAPSHOT_STALE_AFTER_MS)} without a successful browser refresh check`) },
        ],
      };
}

function renderKeyValueList(rows: KeyValueRow[]): string {
  return rows
    .map((row) => {
      const toneClass = row.tone && row.tone !== "empty" ? ` detail__value--${row.tone}` : "";
      return `<div class="detail"><dt>${escapeHtml(row.label)}</dt><dd class="detail__value${toneClass}">${row.value ?? '<span class="muted">Not available yet</span>'}</dd></div>`;
    })
    .join("");
}

function renderCard(title: string, body: string, options: { tone?: Tone; eyebrow?: string } = {}): string {
  const toneClass = options.tone ? ` card--${options.tone}` : "";
  const eyebrow = options.eyebrow ? `<div class="card__eyebrow">${escapeHtml(options.eyebrow)}</div>` : "";
  return `<section class="card${toneClass}">${eyebrow}<h3>${escapeHtml(title)}</h3>${body}</section>`;
}

function renderEmptyCard(title: string, description: string): string {
  return renderCard(title, `<p class="empty-state">${escapeHtml(description)}</p>`, { tone: "empty" });
}

function renderExplanationCard(title: string, explanation: ExplanationCard | undefined, empty: string): string {
  if (!explanation) {
    return renderEmptyCard(title, empty);
  }
  return renderCard(
    title,
    `<p>${escapeHtml(explanation.detail)}</p><dl class="details-grid">${renderKeyValueList(explanation.rows)}</dl>`,
    { tone: explanation.tone, eyebrow: explanation.eyebrow },
  );
}

function renderLatestResultCard<T>(options: {
  title: string;
  latest: LatestResult<T> | undefined;
  empty: string;
  buildRows: (latest: LatestResult<T>) => KeyValueRow[];
}): string {
  if (!options.latest) {
    return renderEmptyCard(options.title, options.empty);
  }
  return renderCard(
    options.title,
    `<dl class="details-grid">${renderKeyValueList(options.buildRows(options.latest))}</dl>`,
    { tone: toneForActionStatus(options.latest.actionStatus), eyebrow: options.latest.actionStatus.toUpperCase() },
  );
}

function renderManualActionState(actionState: PhoenixWebActionState | undefined): string {
  if (actionState?.running) {
    return renderCard(
      "Browser action status",
      `<p>Phoenix is currently running <strong>${escapeHtml(manualActionLabel(actionState.running.action))}</strong>.</p>
       <dl class="details-grid">${renderKeyValueList([
         { label: "State", value: statusBadge("Running", "warning") },
         { label: "Started", value: escapeHtml(formatDateTime(actionState.running.startedAt)) },
         { label: "Action", value: escapeHtml(manualActionLabel(actionState.running.action)) },
       ])}</dl>
       <p class="muted">The browser will refresh automatically when this action finishes so the latest structured Phoenix snapshot is visible.</p>`,
      { tone: "warning", eyebrow: "Action in progress" },
    );
  }
  if (!actionState?.lastCompleted) {
    return renderEmptyCard(
      "Browser action status",
      "No browser-triggered Phoenix action has completed in this web session yet.",
    );
  }
  const completed = actionState.lastCompleted;
  const result = completed.actionResult;
  const rows: KeyValueRow[] = [
    { label: "Action", value: escapeHtml(manualActionLabel(completed.action)) },
    { label: "Finished", value: escapeHtml(formatDateTime(completed.finishedAt)) },
    { label: "Outcome", value: statusBadge(completed.status.toUpperCase(), toneForActionStatus(completed.status)) },
  ];
  if (result.operation === "backup-cycle") {
    rows.push(
      { label: "Archive", value: formatPath(result.backup?.archivePath) },
      { label: "Error", value: result.backup?.error ? escapeHtml(result.backup.error) : "None", tone: result.backup?.error ? "error" : "ok" },
      { label: "Retention pruned", value: escapeHtml(String(result.retention?.deleted.length ?? 0)) },
    );
  }
  if (result.operation === "health-check") {
    rows.push(
      {
        label: "Healthy",
        value: escapeHtml(formatBoolean(result.health?.healthy, "Healthy", "Unhealthy")),
        tone: result.health?.healthy ? "ok" : "error",
      },
      { label: "Reason", value: escapeHtml(result.health?.reason ?? "No reason recorded") },
    );
  }
  return renderCard(
    "Browser action status",
    `<p>${escapeHtml(completed.summary)}</p><dl class="details-grid">${renderKeyValueList(rows)}</dl>`,
    { tone: toneForActionStatus(completed.status), eyebrow: "Latest browser action" },
  );
}

function renderManualActions(snapshot: PhoenixWebSnapshot, actionState: PhoenixWebActionState | undefined): string {
  return `<section class="stack" data-manual-actions-root>
    <div>
      <h2>Manual browser actions</h2>
      <p class="muted">These explicit local-only actions stay inside Phoenix's low-risk browser surface. They do not restore live files, mutate hooks, or edit configuration.</p>
    </div>
    <div class="cards cards--2">
      ${renderCard(
        "Backup now",
        `<p>Create one fresh archive immediately and apply Phoenix retention in the configured output directory. This does not restore anything.</p>
         <p class="muted">Current backup readiness: ${escapeHtml(snapshot.setup.backupReadiness.title)}.</p>
         <button type="button" class="action-button" data-manual-action="backup-now">Run backup now</button>`,
        { tone: toneForReadiness(snapshot.setup.backupReadiness.state) },
      )}
      ${renderCard(
        "Health check now",
        `<p>Run <code>openclaw status --json</code> and record a structured healthy/unhealthy result. This browser action does not roll back live state.</p>
         <p class="muted">Use this when you want a fresh operator-visible health verdict without changing deployed files.</p>
         <button type="button" class="action-button" data-manual-action="health-check-now">Run health check now</button>`,
        { tone: "ok" },
      )}
    </div>
    <div data-manual-action-feedback>${renderManualActionState(actionState)}</div>
  </section>`;
}

function renderOverview(snapshot: PhoenixWebSnapshot, actionState?: PhoenixWebActionState): string {
  const protection = deriveProtectionState(snapshot);
  const watchConfig = snapshot.config.origins.watch;
  const hookConfig = snapshot.config.origins.hook;
  const meaningfulOutcome = buildMeaningfulOutcomeExplanation(snapshot, protection);
  const rollbackExplanation = buildRollbackExplanation(snapshot);
  const notificationExplanation = buildNotificationExplanation(snapshot);
  const freshnessExplanation = buildFreshnessExplanation(snapshot);
  const banner = renderCard(
    "Current protection state",
    `<p>${escapeHtml(protection.detail)}</p>
     <dl class="details-grid">${renderKeyValueList([
       { label: "State", value: statusBadge(protectionStateLabel(protection.state), protection.tone) },
       { label: "Watch mode", value: escapeHtml(watchModeLabel(watchConfig)) },
       { label: "Hook origin", value: escapeHtml(hookModeLabel(hookConfig)) },
       { label: "Latest known-good", value: formatPath(snapshot.overview.latestKnownGoodArchivePath) },
     ])}</dl>`,
    { tone: protection.tone },
  );

  return `${banner}
    ${renderManualActions(snapshot, actionState)}
    <div class="cards cards--2">
      ${renderExplanationCard(
        "Latest meaningful outcome",
        meaningfulOutcome,
        "No watch, hook, or manual Phoenix action has been recorded yet.",
      )}
      ${renderExplanationCard(
        "Data freshness",
        freshnessExplanation,
        "Phoenix has not generated a snapshot yet.",
      )}
      ${renderExplanationCard(
        "Rollback explanation",
        rollbackExplanation,
        "No recovery cycle has recorded rollback state yet.",
      )}
      ${renderExplanationCard(
        "Notification explanation",
        notificationExplanation,
        "No recovery cycle has recorded notification state yet.",
      )}
    </div>
    <div class="cards cards--2">
      ${renderLatestResultCard({
        title: "Latest backup",
        latest: snapshot.overview.latestBackup,
        empty: "No backup cycle has been recorded yet.",
        buildRows: (latest) => [
          { label: "Origin", value: originBadge(latest.origin) },
          { label: "Finished", value: escapeHtml(formatDateTime(latest.finishedAt)) },
          { label: "Archive", value: formatPath(latest.result.archivePath) },
          { label: "Error", value: latest.result.error ? escapeHtml(latest.result.error) : "None" },
        ],
      })}
      ${renderLatestResultCard({
        title: "Latest health",
        latest: snapshot.overview.latestHealth,
        empty: "No health check has been recorded yet.",
        buildRows: (latest) => [
          { label: "Origin", value: originBadge(latest.origin) },
          { label: "Finished", value: escapeHtml(formatDateTime(latest.finishedAt)) },
          { label: "Healthy", value: escapeHtml(formatBoolean(latest.result.healthy, "Healthy", "Unhealthy")), tone: latest.result.healthy ? "ok" : "error" },
          { label: "Reason", value: escapeHtml(latest.result.reason ?? "No reason recorded") },
        ],
      })}
      ${renderLatestResultCard({
        title: "Latest rollback",
        latest: snapshot.overview.latestRollback,
        empty: "No rollback state has been recorded yet.",
        buildRows: (latest) => [
          { label: "Origin", value: originBadge(latest.origin) },
          { label: "Finished", value: escapeHtml(formatDateTime(latest.finishedAt)) },
          { label: "Needed", value: escapeHtml(formatBoolean(latest.result.needed)) },
          { label: "Restored", value: escapeHtml(formatBoolean(latest.result.restored)), tone: latest.result.restored ? "warning" : "ok" },
          { label: "Archive", value: formatPath(latest.result.archivePath) },
          { label: "Error", value: latest.result.error ? escapeHtml(latest.result.error) : "None" },
        ],
      })}
      ${renderLatestResultCard<PhoenixWebNotificationResult>({
        title: "Latest notification",
        latest: snapshot.overview.latestNotification,
        empty: "No notification outcome has been recorded yet.",
        buildRows: (latest) => [
          { label: "Origin", value: originBadge(latest.origin) },
          { label: "Finished", value: escapeHtml(formatDateTime(latest.finishedAt)) },
          { label: "Delivery", value: escapeHtml(latest.result.status), tone: latest.result.status === "failed" ? "error" : latest.result.status === "delivered" ? "ok" : "warning" },
          { label: "Events", value: escapeHtml(String(latest.result.events.length)) },
          { label: "Attempts", value: escapeHtml(String(latest.result.delivery.length)) },
        ],
      })}
    </div>`;
}

function describeActivity(entry: PhoenixActionResult): string {
  const parts: string[] = [];
  if (entry.backup?.archivePath) {
    parts.push(`Backup: ${path.basename(entry.backup.archivePath)}`);
  } else if (entry.backup?.error) {
    parts.push(`Backup failed: ${entry.backup.error}`);
  }
  if (entry.health?.healthy !== undefined) {
    parts.push(`Health: ${entry.health.healthy ? "healthy" : "unhealthy"}`);
  }
  if (entry.rollback?.restored) {
    parts.push(`Rollback restored ${path.basename(entry.rollback.archivePath ?? "archive")}`);
  } else if (entry.rollback?.needed && !entry.rollback.archivePath) {
    parts.push("No known-good archive was available");
  }
  if (entry.notification) {
    parts.push(`Notification: ${entry.notification.status}`);
  }
  return parts.join(" • ");
}

function renderActivity(timeline: PhoenixTimelineReadModel): string {
  if (timeline.entries.length === 0) {
    return renderEmptyCard("Activity", "Phoenix has not recorded any actions yet.");
  }
  return `<section class="stack">${timeline.entries
    .map((entry) => renderCard(
      entry.summary,
      `<div class="inline-badges">${statusBadge(entry.status.toUpperCase(), toneForActionStatus(entry.status))}${originBadge(entry.origin)}<span class="badge badge--muted">${escapeHtml(entry.operation)}</span></div>
       <dl class="details-grid">${renderKeyValueList([
         { label: "Started", value: escapeHtml(formatDateTime(entry.startedAt)) },
         { label: "Finished", value: escapeHtml(formatDateTime(entry.finishedAt)) },
         { label: "Config path", value: formatPath(entry.config.configPath) },
         { label: "Output dir", value: formatPath(entry.config.outputDir) },
       ])}</dl>
       <p class="activity-detail">${escapeHtml(describeActivity(entry) || "No additional structured details were recorded for this action.")}</p>`,
      { tone: toneForActionStatus(entry.status) },
    ))
    .join("")}</section>`;
}

function renderArchiveItem(archive: PhoenixArchiveSummaryItem): string {
  const roleBadges = archive.roles.length > 0
    ? archive.roles.map((role) => statusBadge(role === "latest-known-good" ? "Latest known-good" : "Last backup", "ok")).join("")
    : '<span class="badge badge--muted">Archive</span>';
  return renderCard(
    archive.fileName,
    `<div class="inline-badges">${roleBadges}</div>
     <dl class="details-grid">${renderKeyValueList([
       { label: "Modified", value: escapeHtml(formatDateTime(archive.mtimeAt)) },
       { label: "Size", value: escapeHtml(formatBytes(archive.sizeBytes)) },
       { label: "Path", value: formatPath(archive.archivePath) },
     ])}</dl>`,
  );
}

function renderArchives(snapshot: PhoenixWebSnapshot): string {
  const summary = renderCard(
    "Recovery points",
    `<dl class="details-grid">${renderKeyValueList([
      { label: "Latest known-good", value: formatPath(snapshot.archives.latestKnownGoodArchivePath) },
      { label: "Last backup", value: formatPath(snapshot.archives.lastBackupArchivePath) },
      { label: "Archive count", value: escapeHtml(String(snapshot.archives.archives.length)) },
    ])}</dl>`,
  );
  if (snapshot.archives.archives.length === 0) {
    return `${summary}${renderEmptyCard("Archives", "No backup archives are present in the configured Phoenix output directory.")}`;
  }
  return `${summary}<section class="stack">${snapshot.archives.archives.map(renderArchiveItem).join("")}</section>`;
}

function notificationSummary(config: PhoenixConfigSummaryReadModel["origins"][keyof PhoenixConfigSummaryReadModel["origins"]]): string {
  if (!config) {
    return "Not configured";
  }
  const target = config.notification.target;
  if (!config.notification.enabled) {
    return "Off";
  }
  const targetBits = [target?.to, target?.channel, target?.accountId, target?.threadId].filter(Boolean);
  return targetBits.length > 0
    ? `${config.notification.policy} (${targetBits.join(" • ")})`
    : `${config.notification.policy} (target missing)`;
}

function renderOriginConfig(title: string, mode: string, config: PhoenixConfigSummaryReadModel["origins"][keyof PhoenixConfigSummaryReadModel["origins"]], extraRows: KeyValueRow[] = []): string {
  if (!config) {
    return renderEmptyCard(title, "No recorded configuration summary is available for this origin yet.");
  }
  return renderCard(
    title,
    `<dl class="details-grid">${renderKeyValueList([
      { label: "Mode", value: escapeHtml(mode) },
      { label: "Last run", value: escapeHtml(formatDateTime(config.lastRunAt)) },
      { label: "Config path", value: formatPath(config.configPath) },
      { label: "Output dir", value: formatPath(config.outputDir) },
      { label: "Retain", value: config.retain === undefined ? undefined : escapeHtml(String(config.retain)) },
      { label: "Notification", value: escapeHtml(notificationSummary(config)) },
      ...extraRows,
    ])}</dl>`,
  );
}

function renderSetupItem(item: PhoenixSetupItem): string {
  return renderCard(
    item.title,
    `<div class="inline-badges">${statusBadge(setupSeverityLabel(item.severity), toneForSetupSeverity(item.severity))}${statusBadge(setupPriorityLabel(item.priority), "empty")}${statusBadge(setupSectionLabel(item.section), "empty")}</div>
     <p>${escapeHtml(item.summary)}</p>
     ${item.value ? `<p><strong>Current value:</strong> ${formatPath(item.value)}</p>` : ""}`,
    { tone: toneForSetupSeverity(item.severity) },
  );
}

function renderReadinessCard(title: string, readiness: PhoenixSetupReadiness): string {
  const tone = toneForReadiness(readiness.state);
  return renderCard(
    title,
    `<p>${escapeHtml(readiness.summary)}</p>
     <div class="inline-badges">${statusBadge(readiness.title, tone)}</div>`,
    { tone },
  );
}

function renderSetupSection(title: string, description: string, items: PhoenixSetupItem[]): string {
  if (items.length === 0) {
    return "";
  }
  return `<section class="stack">
    <div>
      <h2>${escapeHtml(title)}</h2>
      <p class="muted">${escapeHtml(description)}</p>
    </div>
    <div class="cards cards--2">${items.map(renderSetupItem).join("")}</div>
  </section>`;
}

function renderSetup(snapshot: PhoenixWebSnapshot): string {
  const environment = snapshot.setup.items.filter((item) => item.section === "environment");
  const backup = snapshot.setup.items.filter((item) => item.section === "backup");
  const selfHeal = snapshot.setup.items.filter((item) => item.section === "self-heal");
  const notifications = snapshot.setup.items.filter((item) => item.section === "notifications");
  return `${renderCard(
    "Guided setup summary",
    `<p>This page is preview-only. It explains what Phoenix still needs, what is optional, and what command to run next. The browser does not apply changes.</p>
     <div class="cards cards--2">
       ${renderReadinessCard("Backup-only readiness", snapshot.setup.backupReadiness)}
       ${renderReadinessCard("Self-heal readiness", snapshot.setup.selfHealReadiness)}
     </div>`,
  )}
    ${renderSetupSection("Environment prerequisites", "Required deployment paths Phoenix depends on for local watch planning.", environment)}
    ${renderSetupSection("Backup basics", "Minimum settings Phoenix needs for archive creation and retention.", backup)}
    ${renderSetupSection("Self-heal", "Optional automatic health-check and rollback setup.", selfHeal)}
    ${renderSetupSection("Notifications", "Optional remote summaries for self-heal runs.", notifications)}
    <section class="stack">
      <div>
        <h2>Preview commands</h2>
        <p class="muted">Copy one of these commands into a terminal when you are ready to apply the shown settings.</p>
      </div>
      <div class="cards cards--2">${snapshot.setup.commands.map((command) => renderCard(
        command.title,
        `<p>${escapeHtml(command.summary)}</p>
         <p class="muted">Preview only — nothing has changed until you run this command yourself.</p>
         <pre class="command-preview"><code>${escapeHtml(command.command)}</code></pre>`,
      )).join("")}</div>
    </section>`;
}

function renderConfiguration(snapshot: PhoenixWebSnapshot): string {
  const deployment = snapshot.config.deployment;
  const warnings = deployment?.warnings ?? [];
  const deploymentCard = deployment
    ? renderCard(
        "Deployment summary",
        `<dl class="details-grid">${renderKeyValueList([
          { label: "Config path", value: formatPath(deployment.configPath) },
          { label: "State dir", value: formatPath(deployment.stateDir) },
          { label: "OAuth dir", value: formatPath(deployment.oauthDir) },
          { label: "Warnings", value: warnings.length === 0 ? "None" : warnings.map(escapeHtml).join("<br />"), tone: warnings.length === 0 ? "ok" : "warning" },
        ])}</dl>
         <p class="muted">This page is read-only. Use the Phoenix CLI for install, remove, watch, and restore operations.</p>`,
        { tone: warnings.length === 0 ? "ok" : "warning" },
      )
    : renderEmptyCard("Deployment summary", "Phoenix could not resolve deployment paths for this snapshot yet.");
  return `${deploymentCard}
    <div class="cards cards--2">
      ${renderOriginConfig("Watch origin", watchModeLabel(snapshot.config.origins.watch), snapshot.config.origins.watch)}
      ${renderOriginConfig("Hook origin", hookModeLabel(snapshot.config.origins.hook), snapshot.config.origins.hook, [
        { label: "Installed", value: escapeHtml(formatBoolean(snapshot.config.origins.hook?.installed)) },
        { label: "Event key", value: snapshot.config.origins.hook?.eventKey ? escapeHtml(snapshot.config.origins.hook.eventKey) : undefined },
        { label: "Hook dir", value: formatPath(snapshot.config.origins.hook?.hookDir) },
      ])}
      ${renderOriginConfig("Manual origin", "Manual restore/recovery history", snapshot.config.origins.manual)}
    </div>`;
}

function renderFreshnessClientScript(snapshot: PhoenixWebSnapshot): string {
  const payload = JSON.stringify({
    generatedAt: snapshot.overview.generatedAt,
    latestFinishedAt: snapshot.overview.latestAction?.finishedAt,
    pollIntervalMs: SNAPSHOT_POLL_INTERVAL_MS,
    staleAfterMs: SNAPSHOT_STALE_AFTER_MS,
  });
  return `<script>
    (() => {
      const badge = document.querySelector('[data-freshness-badge]');
      const text = document.querySelector('[data-freshness-text]');
      const refreshButton = document.querySelector('[data-refresh-now]');
      if (!(badge instanceof HTMLElement) || !(text instanceof HTMLElement)) {
        return;
      }
      const config = ${payload};
      let lastSuccessfulPollAt = Date.now();
      let newestSnapshotAt = '';
      let lastError = '';

      const formatDate = (value) => {
        if (!value) {
          return 'Not recorded yet';
        }
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime())
          ? String(value)
          : parsed.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
      };

      const formatDuration = (value) => {
        if (value < 1_000) {
          return 'under 1 second';
        }
        if (value < 60_000) {
          return String(Math.round(value / 1_000)) + ' second(s)';
        }
        if (value < 3_600_000) {
          return String(Math.round(value / 60_000)) + ' minute(s)';
        }
        if (value < 86_400_000) {
          return String(Math.round(value / 3_600_000)) + ' hour(s)';
        }
        return String(Math.round(value / 86_400_000)) + ' day(s)';
      };

      const setState = (label, tone, message) => {
        badge.textContent = label;
        badge.className = 'badge badge--' + tone;
        text.textContent = message;
      };

      const render = () => {
        const now = Date.now();
        const outcomeAge = config.latestFinishedAt ? formatDuration(Math.max(0, now - new Date(config.latestFinishedAt).getTime())) : null;
        if (newestSnapshotAt) {
          setState('Update available', 'warning', 'New Phoenix data is available from ' + formatDate(newestSnapshotAt) + '. Refresh this page to load the latest explanation.');
          return;
        }
        if (now - lastSuccessfulPollAt > config.staleAfterMs) {
          setState('May be stale', 'error', lastError
            ? 'This page may be stale because the browser could not refresh Phoenix data for ' + formatDuration(now - lastSuccessfulPollAt) + ' (' + lastError + '). Use Refresh now after checking Phoenix is still running.'
            : 'This page may be stale because the browser has not confirmed fresh Phoenix data for ' + formatDuration(now - lastSuccessfulPollAt) + '.');
          return;
        }
        setState(
          'Fresh snapshot',
          'ok',
          outcomeAge
            ? 'Browser checks for newer data every ' + formatDuration(config.pollIntervalMs) + '. Last confirmed check was ' + formatDuration(now - lastSuccessfulPollAt) + ' ago, and the latest recorded Phoenix outcome is ' + outcomeAge + ' old.'
            : 'Browser checks for newer data every ' + formatDuration(config.pollIntervalMs) + '. Last confirmed check was ' + formatDuration(now - lastSuccessfulPollAt) + ' ago.',
        );
      };

      const poll = async () => {
        try {
          const response = await fetch('/api/snapshot', { headers: { accept: 'application/json' }, cache: 'no-store' });
          if (!response.ok) {
            throw new Error('HTTP ' + response.status);
          }
          const nextSnapshot = await response.json();
          lastSuccessfulPollAt = Date.now();
          lastError = '';
          const nextGeneratedAt = nextSnapshot?.overview?.generatedAt;
          if (typeof nextGeneratedAt === 'string' && nextGeneratedAt && nextGeneratedAt !== config.generatedAt) {
            newestSnapshotAt = nextGeneratedAt;
          }
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }
        render();
      };

      render();
      window.setInterval(render, 1_000);
      window.setInterval(poll, config.pollIntervalMs);
      refreshButton?.addEventListener('click', () => window.location.reload());
    })();
  </script>`;
}

function renderManualActionClientScript(actionState: PhoenixWebActionState | undefined): string {
  const payload = JSON.stringify(actionState ?? {});
  return `<script>
    (() => {
      const root = document.querySelector('[data-manual-actions-root]');
      if (!(root instanceof HTMLElement)) {
        return;
      }
      const buttons = Array.from(root.querySelectorAll('[data-manual-action]'));
      const feedback = root.querySelector('[data-manual-action-feedback]');
      if (!(feedback instanceof HTMLElement)) {
        return;
      }
      let state = ${payload};
      let pollTimer = 0;
      let waitingForCompletion = Boolean(state?.running);

      const updateButtons = () => {
        const disabled = Boolean(state?.running);
        for (const button of buttons) {
          if (button instanceof HTMLButtonElement) {
            button.disabled = disabled;
          }
        }
      };

      const renderRunning = () => {
        if (!state?.running) {
          return;
        }
        const label = state.running.action === 'backup-now' ? 'Backup now' : 'Health check now';
        feedback.innerHTML = '<section class="card card--warning"><div class="card__eyebrow">Action in progress</div><h3>Browser action status</h3><p>Phoenix is currently running <strong>' + label + '</strong>.</p><p class="muted">Started ' + new Date(state.running.startedAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) + '. The page will refresh when the action finishes.</p></section>';
      };

      const setTemporaryError = (message) => {
        feedback.innerHTML = '<section class="card card--error"><div class="card__eyebrow">Action failed to start</div><h3>Browser action status</h3><p>' + message + '</p></section>';
      };

      const sync = async () => {
        try {
          const response = await fetch('/api/actions/state', { headers: { accept: 'application/json' }, cache: 'no-store' });
          if (!response.ok) {
            throw new Error('HTTP ' + response.status);
          }
          state = await response.json();
          updateButtons();
          if (state?.running) {
            renderRunning();
            return;
          }
          if (waitingForCompletion) {
            window.location.reload();
          }
        } catch (error) {
          setTemporaryError(error instanceof Error ? error.message : String(error));
        }
      };

      const ensurePolling = () => {
        if (pollTimer) {
          return;
        }
        pollTimer = window.setInterval(sync, 1000);
      };

      updateButtons();
      if (state?.running) {
        renderRunning();
        ensurePolling();
      }

      for (const button of buttons) {
        if (!(button instanceof HTMLButtonElement)) {
          continue;
        }
        button.addEventListener('click', async () => {
          const action = button.dataset.manualAction;
          if (!action) {
            return;
          }
          try {
            const response = await fetch('/api/actions/' + action, {
              method: 'POST',
              headers: { accept: 'application/json' },
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) {
              state = payload?.state ?? state;
              updateButtons();
              setTemporaryError(String(payload?.error ?? ('HTTP ' + response.status)));
              return;
            }
            state = payload.state;
            waitingForCompletion = true;
            updateButtons();
            renderRunning();
            ensurePolling();
          } catch (error) {
            setTemporaryError(error instanceof Error ? error.message : String(error));
          }
        });
      }
    })();
  </script>`;
}

function renderLayout(view: PhoenixConsoleView, snapshot: PhoenixWebSnapshot, body: string, actionState?: PhoenixWebActionState): string {
  const protection = deriveProtectionState(snapshot);
  const freshness = buildFreshnessExplanation(snapshot);
  const nav = (Object.keys(VIEW_TITLES) as PhoenixConsoleView[])
    .map((entry) => `<a class="nav__link${entry === view ? " nav__link--active" : ""}" href="/${entry}">${escapeHtml(VIEW_TITLES[entry])}</a>`)
    .join("");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>OpenClaw Phoenix Console • ${escapeHtml(VIEW_TITLES[view])}</title>
    <style>
      :root { color-scheme: light dark; font-family: Inter, system-ui, sans-serif; }
      body { margin: 0; background: #0f172a; color: #e2e8f0; }
      a { color: inherit; text-decoration: none; }
      code { font-family: ui-monospace, monospace; font-size: 0.92em; }
      h1 { margin: 0 0 8px; }
      h2 { margin: 0 0 8px; font-size: 1.05rem; }
      .shell { max-width: 1180px; margin: 0 auto; padding: 24px; }
      .topbar, .banner, .card { border: 1px solid #334155; border-radius: 16px; background: rgba(15, 23, 42, 0.88); }
      .topbar { display: flex; justify-content: space-between; gap: 16px; align-items: center; padding: 20px; margin-bottom: 20px; }
      .topbar__status { max-width: 380px; }
      .nav { display: flex; flex-wrap: wrap; gap: 10px; }
      .nav__link { padding: 10px 14px; border-radius: 999px; background: #1e293b; color: #cbd5e1; }
      .nav__link--active { background: #2563eb; color: white; }
      .refresh-button { appearance: none; border: 1px solid #475569; border-radius: 999px; background: #1e293b; color: #e2e8f0; cursor: pointer; padding: 8px 12px; }
      .action-button { appearance: none; border: 1px solid rgba(125, 211, 252, 0.45); border-radius: 10px; background: rgba(14, 116, 144, 0.25); color: #e2e8f0; cursor: pointer; font: inherit; margin-top: 12px; padding: 10px 14px; }
      .action-button:disabled { cursor: wait; opacity: 0.65; }
      .refresh-button:hover { border-color: #93c5fd; }
      .banner { padding: 20px; margin-bottom: 20px; }
      .banner--ok { border-color: #15803d; }
      .banner--warning { border-color: #ca8a04; }
      .banner--error { border-color: #dc2626; }
      .banner--empty { border-color: #475569; }
      .cards { display: grid; gap: 16px; }
      .cards--2 { grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
      .stack { display: grid; gap: 16px; }
      .card { padding: 18px; }
      .card--ok { border-color: #15803d; }
      .card--warning { border-color: #ca8a04; }
      .card--error { border-color: #dc2626; }
      .card--empty { border-style: dashed; }
      .card h3 { margin: 0 0 12px; font-size: 1.05rem; }
      .card__eyebrow { margin-bottom: 8px; color: #94a3b8; font-size: 0.8rem; letter-spacing: 0.08em; }
      .details-grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
      .detail dt { color: #94a3b8; font-size: 0.82rem; margin-bottom: 4px; }
      .detail dd { margin: 0; }
      .detail__value--ok { color: #86efac; }
      .detail__value--warning { color: #fde68a; }
      .detail__value--error { color: #fca5a5; }
      .badge { display: inline-flex; align-items: center; padding: 4px 10px; border-radius: 999px; font-size: 0.78rem; margin-right: 8px; margin-bottom: 8px; }
      .badge--ok { background: rgba(34, 197, 94, 0.2); color: #86efac; }
      .badge--warning { background: rgba(234, 179, 8, 0.2); color: #fde68a; }
      .badge--error { background: rgba(239, 68, 68, 0.2); color: #fecaca; }
      .badge--empty, .badge--muted, .badge--origin { background: rgba(148, 163, 184, 0.18); color: #cbd5e1; }
      .inline-badges { margin-bottom: 8px; }
      .muted, .empty-state, .activity-detail { color: #94a3b8; }
      .command-preview { margin: 0; white-space: pre-wrap; word-break: break-word; background: rgba(15, 23, 42, 0.65); border: 1px solid #334155; border-radius: 12px; padding: 14px; }
      @media (max-width: 760px) { .shell { padding: 16px; } .topbar { flex-direction: column; align-items: flex-start; } .topbar__status { max-width: none; width: 100%; } }
    </style>
  </head>
  <body>
    <main class="shell">
      <header class="topbar">
        <div>
          <h1>OpenClaw Phoenix Console</h1>
          <p class="muted">Local operator console built from the Phoenix Web v1 snapshot contract, with only low-risk browser actions enabled.</p>
        </div>
        <div class="topbar__status">
          <div class="inline-badges"><span class="badge badge--${freshness.tone}" data-freshness-badge>${escapeHtml(freshness.eyebrow)}</span></div>
          <p class="muted" data-freshness-text>${escapeHtml(freshness.detail)}</p>
          <button type="button" class="refresh-button" data-refresh-now>Refresh now</button>
        </div>
        <nav class="nav">${nav}<a class="nav__link" href="/api/snapshot">Snapshot JSON</a></nav>
      </header>
      <section class="banner banner--${protection.tone}">
        <div class="inline-badges">${statusBadge(protectionStateLabel(protection.state), protection.tone)}</div>
        <p>${escapeHtml(protection.detail)}</p>
        <p class="muted">Generated ${escapeHtml(formatDateTime(snapshot.overview.generatedAt))}. Browser checks for newer data every ${escapeHtml(formatDuration(SNAPSHOT_POLL_INTERVAL_MS))} and warns when the page becomes stale.</p>
      </section>
      ${body}
    </main>
    ${renderFreshnessClientScript(snapshot)}
    ${view === "overview" ? renderManualActionClientScript(actionState) : ""}
  </body>
</html>`;
}

export function renderPhoenixWebConsolePage(snapshot: PhoenixWebSnapshot, view: PhoenixConsoleView, actionState?: PhoenixWebActionState): string {
  switch (view) {
    case "overview":
      return renderLayout(view, snapshot, renderOverview(snapshot, actionState), actionState);
    case "setup":
      return renderLayout(view, snapshot, renderSetup(snapshot), actionState);
    case "activity":
      return renderLayout(view, snapshot, renderActivity(snapshot.timeline), actionState);
    case "archives":
      return renderLayout(view, snapshot, renderArchives(snapshot), actionState);
    case "configuration":
      return renderLayout(view, snapshot, renderConfiguration(snapshot), actionState);
  }
}

export function renderPhoenixWebConsoleErrorPage(options: {
  error: unknown;
  pathname: string;
  view?: PhoenixConsoleView;
}): string {
  const detail = escapeHtml(options.error instanceof Error ? options.error.message : String(options.error));
  const title = options.view ? `${VIEW_TITLES[options.view]} unavailable` : "Phoenix console error";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>${title}</title></head>
<body style="font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0; margin: 0;">
  <main style="max-width: 820px; margin: 0 auto; padding: 24px;">
    <h1>${escapeHtml(title)}</h1>
    <p>This local Phoenix console could not load the requested view.</p>
    <p><strong>Route:</strong> <code>${escapeHtml(options.pathname)}</code></p>
    <pre style="white-space: pre-wrap; background: rgba(15,23,42,0.9); border: 1px solid #dc2626; border-radius: 12px; padding: 16px;">${detail}</pre>
    <p>Verify the configured <code>--config</code> and <code>--output</code> paths, then refresh the page.</p>
  </main>
</body></html>`;
}

function normalizeManualAction(pathname: string): PhoenixWebManualAction | undefined {
  if (pathname === "/api/actions/backup-now") {
    return "backup-now";
  }
  if (pathname === "/api/actions/health-check-now") {
    return "health-check-now";
  }
  return undefined;
}

function writeResponse(response: http.ServerResponse, status: number, contentType: string, body: string, method = "GET") {
  response.writeHead(status, { "content-type": `${contentType}; charset=utf-8` });
  if (method === "HEAD") {
    response.end();
    return;
  }
  response.end(body);
}

export async function startPhoenixWebConsole(options: StartPhoenixWebConsoleOptions): Promise<PhoenixWebConsoleServer> {
  let closeResolver = () => {};
  const closed = new Promise<void>((resolve) => {
    closeResolver = resolve;
  });
  const server = http.createServer(async (request, response) => {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    if (url.pathname === "/api/actions/state") {
      if (!options.actionController) {
        writeResponse(response, 404, "application/json", `${JSON.stringify({ ok: false, error: "Manual browser actions are unavailable." }, null, 2)}\n`, method);
        return;
      }
      if (method !== "GET" && method !== "HEAD") {
        writeResponse(response, 405, "text/plain", "Method Not Allowed", method);
        return;
      }
      writeResponse(response, 200, "application/json", `${JSON.stringify(options.actionController.getState(), null, 2)}\n`, method);
      return;
    }
    const manualAction = normalizeManualAction(url.pathname);
    if (manualAction) {
      if (!options.actionController) {
        writeResponse(response, 404, "application/json", `${JSON.stringify({ ok: false, error: "Manual browser actions are unavailable." }, null, 2)}\n`, method);
        return;
      }
      if (method !== "POST") {
        writeResponse(response, 405, "text/plain", "Method Not Allowed", method);
        return;
      }
      const result = await options.actionController.start(manualAction);
      writeResponse(response, result.ok ? 202 : 409, "application/json", `${JSON.stringify(result, null, 2)}\n`, method);
      return;
    }
    if (method !== "GET" && method !== "HEAD") {
      writeResponse(response, 405, "text/plain", "Method Not Allowed", method);
      return;
    }
    if (url.pathname === "/api/snapshot") {
      try {
        const snapshot = await options.loadSnapshot();
        writeResponse(response, 200, "application/json", `${JSON.stringify(snapshot, null, 2)}\n`, method);
      } catch (error) {
        writeResponse(response, 500, "application/json", `${JSON.stringify({ ok: false, error: String(error) }, null, 2)}\n`, method);
      }
      return;
    }
    const view = normalizeView(url.pathname);
    if (!view) {
      writeResponse(response, 404, "text/html", renderPhoenixWebConsoleErrorPage({ error: "Page not found", pathname: url.pathname }), method);
      return;
    }
    try {
      const snapshot = await options.loadSnapshot();
      writeResponse(response, 200, "text/html", renderPhoenixWebConsolePage(snapshot, view, options.actionController?.getState()), method);
    } catch (error) {
      writeResponse(response, 500, "text/html", renderPhoenixWebConsoleErrorPage({ error, pathname: url.pathname, view }), method);
    }
  });
  server.on("close", () => closeResolver());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 48789, options.host ?? "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://${options.host ?? "127.0.0.1"}:${address.port}`,
    close: async () => {
      if (!server.listening) {
        return;
      }
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
    closed,
  };
}