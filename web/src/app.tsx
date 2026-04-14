import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { BrowserRouter, NavLink, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { I18nextProvider, useTranslation } from "react-i18next";
import { motion, AnimatePresence } from "framer-motion";
import {
  GearSix,
  ClockCounterClockwise,
  PlugsConnected,
  Archive,
  ListDashes,
  ArrowClockwise,
  Play,
  Stop,
  CloudArrowDown,
  Heartbeat,
  CheckCircle,
  Warning,
  XCircle,
  CaretRight,
  Globe,
  Moon,
  Sun,
} from "@phosphor-icons/react";
import type { ActionState, ConsoleBootstrap, ConsoleLocale, ConsoleTheme, ConsoleView, PhoenixWebSnapshot } from "./types";
import { i18n } from "./i18n";
import { useStatusTranslation } from "./i18n/useStatusTranslation";

type WebAction =
  | "backup-now"
  | "health-check-now"
  | "watch-start"
  | "watch-stop"
  | "hook-install"
  | "hook-remove"
  | "hook-run";

type NotificationFormState = {
  mode: "off" | "exceptional-only" | "all";
  to: string;
};

const viewLabels: Record<ConsoleView, string> = {
  overview: "overview",
  setup: "setup",
  activity: "activity",
  archives: "archives",
  configuration: "configuration",
};

const viewIcons: Record<ConsoleView, React.ElementType> = {
  overview: ListDashes,
  setup: GearSix,
  activity: ClockCounterClockwise,
  archives: Archive,
  configuration: PlugsConnected,
};

const actionPaths: Record<WebAction, string> = {
  "backup-now": "/api/actions/backup-now",
  "health-check-now": "/api/actions/health-check-now",
  "watch-start": "/api/actions/watch/start",
  "watch-stop": "/api/actions/watch/stop",
  "hook-install": "/api/actions/hook/install",
  "hook-remove": "/api/actions/hook/remove",
  "hook-run": "/api/actions/hook/run",
};

const ACTION_STATE_POLL_MS = 1_000;

function buildInitialActionState(): ActionState {
  return {
    watch: { status: "stopped" },
    capabilities: {
      "backup-now": { enabled: false, reason: "Loading..." },
      "health-check-now": { enabled: false, reason: "Loading..." },
      "watch-start": { enabled: false, reason: "Loading..." },
      "watch-stop": { enabled: false, reason: "Loading..." },
      "hook-install": { enabled: false, reason: "Loading..." },
      "hook-remove": { enabled: false, reason: "Loading..." },
      "hook-run": { enabled: false, reason: "Loading..." },
    },
  };
}

function createNotificationFormState(source?: {
  enabled?: boolean;
  policy?: string;
  target?: { to?: string };
  targetConfigured?: boolean;
}): NotificationFormState {
  return {
    mode: source?.enabled === false || source?.policy === "off"
      ? "off"
      : source?.policy === "all"
        ? "all"
        : source?.enabled
          ? "exceptional-only"
          : "off",
    to: source?.target?.to ?? "",
  };
}

function toNotificationPayload(form: NotificationFormState) {
  if (form.mode === "off") {
    return { enabled: false, policy: "off" as const };
  }
  return {
    enabled: true,
    policy: form.mode,
    target: form.to ? { to: form.to } : undefined,
  };
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json")
    ? await response.json().catch(() => undefined)
    : await response.text().catch(() => "");
  if (!response.ok) {
    if (payload && typeof payload === "object" && "error" in payload) {
      throw new Error(String((payload as { error: string }).error));
    }
    throw new Error(typeof payload === "string" ? payload : `HTTP ${response.status}`);
  }
  return payload as T;
}

function formatDateTime(locale: ConsoleLocale, value?: string): string {
  if (!value) {
    return "—";
  }
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function isActionStateBusy(state: ActionState): boolean {
  return Boolean(state.runningMutation)
    || state.watch.status === "starting"
    || state.watch.status === "stopping";
}

function usePreferences(defaultLocale: ConsoleLocale, defaultTheme: ConsoleTheme) {
  const [locale, setLocale] = useState<ConsoleLocale>(() => {
    const stored = window.localStorage.getItem("phoenix-console-locale");
    return stored === "zh-CN" ? "zh-CN" : defaultLocale;
  });
  const [theme, setTheme] = useState<ConsoleTheme>(() => {
    const stored = window.localStorage.getItem("phoenix-console-theme");
    return stored === "light" ? "light" : defaultTheme;
  });

  useEffect(() => {
    document.documentElement.lang = locale;
    window.localStorage.setItem("phoenix-console-locale", locale);
    void i18n.changeLanguage(locale);
  }, [locale]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("phoenix-console-theme", theme);
  }, [theme]);

  return { locale, theme, setLocale, setTheme };
}

function useConsoleBootstrap() {
  const [bootstrap, setBootstrap] = useState<ConsoleBootstrap | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetchJson<ConsoleBootstrap>("/api/console/bootstrap")
      .then(setBootstrap)
      .catch((nextError) => setError(String(nextError)));
  }, []);

  return { bootstrap, error };
}

function useSnapshot() {
  const [snapshot, setSnapshot] = useState<PhoenixWebSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void fetchJson<PhoenixWebSnapshot>("/api/snapshot")
      .then((nextSnapshot) => {
        if (!cancelled) {
          setSnapshot(nextSnapshot);
          setError(null);
        }
      })
      .catch((nextError) => {
        if (!cancelled) {
          setError(String(nextError));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [refreshToken]);

  return {
    snapshot,
    error,
    refresh: () => setRefreshToken((current) => current + 1),
  };
}

function useActionState() {
  const [actionState, setActionState] = useState<ActionState>(buildInitialActionState());
  const refresh = async () => {
    const nextState = await fetchJson<ActionState>("/api/actions/state");
    setActionState(nextState);
    return nextState;
  };

  useEffect(() => {
    void refresh().catch(() => {});
  }, []);

  return { actionState, refresh, setActionState };
}

function usePhoenixActions(onRefreshSnapshot: () => void, onActionState: (state: ActionState) => void) {
  const [runningAction, setRunningAction] = useState<WebAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  const start = async (action: WebAction, body?: unknown) => {
    setRunningAction(action);
    setError(null);
    try {
      const response = await fetchJson<{ ok: boolean; state: ActionState }>(actionPaths[action], {
        method: "POST",
        headers: {
          origin: window.location.origin,
          "content-type": "application/json",
          "x-phoenix-web-action": action,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      onActionState(response.state);
      onRefreshSnapshot();
      return response;
    } catch (nextError) {
      setError(String(nextError));
      throw nextError;
    } finally {
      setRunningAction(null);
    }
  };

  return { runningAction, error, start, clearError: () => setError(null) };
}

function Badge({ tone, children, pulse }: { tone: "success" | "warning" | "error" | "muted"; children: ReactNode; pulse?: boolean }) {
  return (
    <span className={`badge badge--${tone}`}>
      {pulse && <span className="badge-dot" />}
      {children}
    </span>
  );
}

function Card({ title, children, className = "", delay = 0 }: { title: string; children: ReactNode; className?: string; delay?: number }) {
  return (
    <motion.div
      className={`card ${className}`}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: delay * 0.05, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className="card-header">
        <h2 className="card-title">{title}</h2>
      </div>
      {children}
    </motion.div>
  );
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="form-field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
    </div>
  );
}

function SegmentedControl({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <div className="segmented-control">
      {options.map((opt) => (
        <button
          key={opt.value}
          className={value === opt.value ? "active" : ""}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function OverviewPage(props: {
  locale: ConsoleLocale;
  posture: ConsoleBootstrap["posture"];
  snapshot: PhoenixWebSnapshot | null;
  actionState: ActionState;
  actionError: string | null;
  runningAction: WebAction | null;
  onBackupNow: () => Promise<void>;
  onHealthCheckNow: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const { translateStatus } = useStatusTranslation();
  const latestSummary = props.snapshot?.overview.latestAction?.summary ?? t("noData");
  const backupCapability = props.actionState.capabilities["backup-now"];
  const healthCapability = props.actionState.capabilities["health-check-now"];
  const actionBusy = isActionStateBusy(props.actionState);
  const hookInstalled = props.snapshot?.config.origins.hook?.installed === true;

  const watchTone = props.actionState.watch.status === "running" ? "success" : "muted";
  const hookTone = hookInstalled ? "success" : "muted";

  return (
    <div className="bento-grid animate-stagger">
      <Card title={t("runtimeStatus")} delay={1}>
        <div className="detail-list">
          <div className="detail-item">
            <span className="detail-label">{t("watchStatus")}</span>
            <Badge tone={watchTone} pulse={props.actionState.watch.status === "running"}>{translateStatus(props.actionState.watch.status)}</Badge>
          </div>
          <div className="detail-item">
            <span className="detail-label">{t("hookStatus")}</span>
            <Badge tone={hookTone}>{hookInstalled ? t("hookInstalled") : t("hookNotInstalled")}</Badge>
          </div>
          <div className="detail-item">
            <span className="detail-label">{t("runningMutation")}</span>
            <span className="detail-value">{props.actionState.runningMutation?.action ?? "—"}</span>
          </div>
        </div>
      </Card>

      <Card title={t("latestOutcome")} delay={2}>
        <p className="text-muted" style={{ marginBottom: "1rem" }}>{latestSummary}</p>
        <div className="detail-list">
          <div className="detail-item">
            <span className="detail-label">{t("currentPosture")}</span>
            <span className="detail-value">{props.posture.bindingMode}</span>
          </div>
          <div className="detail-item">
            <span className="detail-label">{t("dataFreshness")}</span>
            <span className="detail-value mono">{formatDateTime(props.locale, props.snapshot?.overview.generatedAt)}</span>
          </div>
        </div>
      </Card>

      <Card title={t("manualActions")} delay={3}>
        <p className="text-muted" style={{ marginBottom: "0.75rem", fontSize: "0.8rem" }}>{t(props.posture.manualActionsDetail)}</p>
        <div className="btn-row">
          <motion.button
            className="btn btn-primary"
            disabled={!props.posture.manualActionsAvailable || !backupCapability.enabled || props.runningAction !== null || actionBusy}
            onClick={() => void props.onBackupNow()}
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
          >
            <CloudArrowDown weight="bold" />
            {t("backupNow")}
          </motion.button>
          <motion.button
            className="btn btn-primary"
            disabled={!props.posture.manualActionsAvailable || !healthCapability.enabled || props.runningAction !== null || actionBusy}
            onClick={() => void props.onHealthCheckNow()}
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
          >
            <Heartbeat weight="bold" />
            {t("healthNow")}
          </motion.button>
        </div>
        {!props.posture.manualActionsAvailable && <p className="text-muted" style={{ marginTop: "0.75rem", fontSize: "0.75rem" }}>{t("actionsUnavailable")}</p>}
        {backupCapability.reason && <p className="text-muted" style={{ marginTop: "0.5rem", fontSize: "0.75rem" }}>{backupCapability.reason}</p>}
        {props.runningAction && <p className="text-muted" style={{ marginTop: "0.5rem", fontSize: "0.75rem" }}>{t("actionRunning")}: {props.runningAction}</p>}
        {props.actionError && <p className="error-text" style={{ marginTop: "0.5rem", fontSize: "0.75rem" }}>{props.actionError}</p>}
      </Card>

      <Card title={t("rollback")} delay={4}>
        <p className="mono" style={{ fontSize: "0.8rem" }}>
          {props.snapshot?.overview.latestRollback?.result.error ?? props.snapshot?.overview.latestRollback?.result.archivePath ?? t("noData")}
        </p>
      </Card>

      <Card title={t("notification")} delay={5}>
        <p className="mono" style={{ fontSize: "0.8rem" }}>
          {props.snapshot?.overview.latestNotification?.result.status ?? t("noData")}
        </p>
      </Card>
    </div>
  );
}

function SetupPage({ snapshot }: { snapshot: PhoenixWebSnapshot | null }) {
  const { t } = useTranslation();
  return (
    <div className="bento-grid animate-stagger">
      <Card title={t("setupSummary")} className="bento-col-span-2" delay={1}>
        <div className="detail-list">
          <div className="detail-item">
            <span className="detail-label">{t("backup")}</span>
            <span className="detail-value">{snapshot?.setup.backupReadiness.summary ?? t("loading")}</span>
          </div>
          <div className="detail-item">
            <span className="detail-label">{t("selfHeal")}</span>
            <span className="detail-value">{snapshot?.setup.selfHealReadiness.summary ?? t("loading")}</span>
          </div>
        </div>
      </Card>
      <Card title={t("previewCommands")} delay={2}>
        {snapshot?.setup.commands.length ? (
          <div className="stack">
            {snapshot.setup.commands.map((command) => (
              <pre key={command.id}>{command.command}</pre>
            ))}
          </div>
        ) : <p className="text-muted">{t("noData")}</p>}
      </Card>
    </div>
  );
}

function ActivityPage({ snapshot, locale }: { snapshot: PhoenixWebSnapshot | null; locale: ConsoleLocale }) {
  const { t } = useTranslation();
  const runs = snapshot?.timeline.runs ?? [];

  return (
    <div className="bento-grid animate-stagger">
      {runs.length === 0 ? (
        <Card title={t("activity")} className="bento-col-span-2" delay={1}>
          <div className="empty-state">
            <ClockCounterClockwise className="empty-state-icon" />
            <p>{t("noData")}</p>
          </div>
        </Card>
      ) : (
        runs.map((run, index) => (
          <Card key={run.actionId} title={run.summary} delay={index + 1}>
            <p className="text-muted" style={{ fontSize: "0.8rem", marginBottom: "0.75rem" }}>
              {run.origin} · {run.operation} · {formatDateTime(locale, run.finishedAt)}
            </p>
            <div className="timeline">
              {run.stages.map((stage, idx) => (
                <div key={`${stage.type}-${idx}`} className="timeline-item" style={{ paddingLeft: "1rem" }}>
                  <span className="mono" style={{ fontSize: "0.75rem" }}>{stage.type}</span>
                  <p className="text-muted" style={{ fontSize: "0.75rem" }}>{stage.detail}</p>
                </div>
              ))}
            </div>
          </Card>
        ))
      )}
    </div>
  );
}

function ArchivesPage({ snapshot, locale }: { snapshot: PhoenixWebSnapshot | null; locale: ConsoleLocale }) {
  const { t } = useTranslation();
  return (
    <div className="bento-grid animate-stagger">
      <Card title={t("recoveryPoints")} delay={1}>
        <div className="detail-list">
          <div className="detail-item">
            <span className="detail-label">{t("knownGood")}</span>
            <span className="detail-value mono" style={{ fontSize: "0.75rem" }}>{snapshot?.archives.latestKnownGoodArchivePath ?? "—"}</span>
          </div>
          <div className="detail-item">
            <span className="detail-label">{t("lastBackup")}</span>
            <span className="detail-value mono" style={{ fontSize: "0.75rem" }}>{snapshot?.archives.lastBackupArchivePath ?? "—"}</span>
          </div>
        </div>
      </Card>
      <Card title={t("archiveInventory")} className="bento-col-span-2" delay={2}>
        {snapshot?.archives.archives.length ? (
          <div className="detail-list">
            {snapshot.archives.archives.map((archive) => (
              <div key={archive.archivePath} className="detail-item">
                <span className="detail-value">{archive.fileName}</span>
                <span className="detail-value mono">{formatDateTime(locale, archive.mtimeAt)}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-state">
            <Archive className="empty-state-icon" />
            <p>{t("emptyArchives")}</p>
          </div>
        )}
      </Card>
    </div>
  );
}

function ConfigurationPage(props: {
  locale: ConsoleLocale;
  bootstrap: ConsoleBootstrap;
  snapshot: PhoenixWebSnapshot | null;
  actionState: ActionState;
  actionError: string | null;
  onStartWatch: (input: { selfHeal: boolean; notification: ReturnType<typeof toNotificationPayload> }) => Promise<void>;
  onStopWatch: () => Promise<void>;
  onInstallHook: (input: { eventKey: string; notification: ReturnType<typeof toNotificationPayload> }) => Promise<void>;
  onRemoveHook: () => Promise<void>;
  onRunHook: (input: { notification: ReturnType<typeof toNotificationPayload> }) => Promise<void>;
}) {
  const { t } = useTranslation();
  const { translateStatus } = useStatusTranslation();
  const origins = props.snapshot?.config.origins ?? {};
  const [watchSelfHeal, setWatchSelfHeal] = useState(Boolean(props.actionState.watch.selfHeal ?? origins.watch?.selfHeal));
  const [watchNotification, setWatchNotification] = useState<NotificationFormState>(() =>
    createNotificationFormState({
      enabled: props.actionState.watch.notification?.enabled ?? origins.watch?.notification.enabled,
      policy: props.actionState.watch.notification?.policy ?? origins.watch?.notification.policy,
      target: props.actionState.watch.notification?.target,
    }),
  );
  const [hookEvent, setHookEvent] = useState(origins.hook?.eventKey ?? props.bootstrap.actions.defaultHookEvent);
  const [hookNotification, setHookNotification] = useState<NotificationFormState>(() =>
    createNotificationFormState(origins.hook?.notification),
  );

  useEffect(() => {
    setWatchSelfHeal(Boolean(props.actionState.watch.selfHeal ?? origins.watch?.selfHeal));
    setWatchNotification(
      createNotificationFormState({
        enabled: props.actionState.watch.notification?.enabled ?? origins.watch?.notification.enabled,
        policy: props.actionState.watch.notification?.policy ?? origins.watch?.notification.policy,
        target: props.actionState.watch.notification?.target,
      }),
    );
    setHookEvent(origins.hook?.eventKey ?? props.bootstrap.actions.defaultHookEvent);
    setHookNotification(createNotificationFormState(origins.hook?.notification));
  }, [
    origins.hook?.eventKey,
    origins.hook?.notification.enabled,
    origins.hook?.notification.policy,
    origins.watch?.notification.enabled,
    origins.watch?.notification.policy,
    origins.watch?.selfHeal,
    props.actionState.watch.notification?.enabled,
    props.actionState.watch.notification?.policy,
    props.actionState.watch.notification?.target?.to,
    props.actionState.watch.selfHeal,
    props.bootstrap.actions.defaultHookEvent,
  ]);

  const watchStartCapability = props.actionState.capabilities["watch-start"];
  const watchStopCapability = props.actionState.capabilities["watch-stop"];
  const hookInstallCapability = props.actionState.capabilities["hook-install"];
  const hookRemoveCapability = props.actionState.capabilities["hook-remove"];
  const hookRunCapability = props.actionState.capabilities["hook-run"];

  return (
    <div className="bento-grid animate-stagger">
      <Card title={t("deploymentSummary")} delay={1}>
        <div className="detail-list">
          <div className="detail-item">
            <span className="detail-label">{t("config")}</span>
            <span className="detail-value mono" style={{ fontSize: "0.7rem" }}>{props.snapshot?.config.deployment?.configPath ?? "—"}</span>
          </div>
          <div className="detail-item">
            <span className="detail-label">{t("state")}</span>
            <span className="detail-value mono" style={{ fontSize: "0.7rem" }}>{props.snapshot?.config.deployment?.stateDir ?? "—"}</span>
          </div>
        </div>
      </Card>

      <Card title={t("modeControls")} className="bento-col-span-2" delay={2}>
        <div className="stack">
          <div className="stack-section">
            <h3>{t("runtimeStatus")}</h3>
            <div className="detail-list">
              <div className="detail-item">
                <span className="detail-label">{t("watchStatus")}</span>
                <Badge tone={props.actionState.watch.status === "running" ? "success" : "muted"} pulse={props.actionState.watch.status === "running"}>{translateStatus(props.actionState.watch.status)}</Badge>
              </div>
              <div className="detail-item">
                <span className="detail-label">{t("hookStatus")}</span>
                <Badge tone={origins.hook?.installed ? "success" : "muted"}>{origins.hook?.installed ? t("hookInstalled") : t("hookNotInstalled")}</Badge>
              </div>
            </div>
          </div>

          <div className="stack-section">
            <h3>{t("watchControls")}</h3>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "0.75rem" }}>
              <Field label={t("watchSelfHeal")} htmlFor="watch-self-heal">
                <input
                  id="watch-self-heal"
                  type="checkbox"
                  checked={watchSelfHeal}
                  onChange={(event) => setWatchSelfHeal(event.target.checked)}
                />
              </Field>
              <Field label={t("watchNotifyMode")} htmlFor="watch-notify-mode">
                <select
                  id="watch-notify-mode"
                  value={watchNotification.mode}
                  onChange={(event) => setWatchNotification((current) => ({ ...current, mode: event.target.value as NotificationFormState["mode"] }))}
                >
                  <option value="off">{t("notifyOff")}</option>
                  <option value="exceptional-only">{t("notifyExceptional")}</option>
                  <option value="all">{t("notifyAll")}</option>
                </select>
              </Field>
              <Field label={t("watchNotifyTarget")} htmlFor="watch-notify-target">
                <input
                  id="watch-notify-target"
                  value={watchNotification.to}
                  onChange={(event) => setWatchNotification((current) => ({ ...current, to: event.target.value }))}
                  placeholder={t("webhookUrl")}
                />
              </Field>
            </div>
            <div className="btn-row">
              <motion.button
                className="btn btn-primary"
                disabled={!watchStartCapability.enabled}
                onClick={() => void props.onStartWatch({
                  selfHeal: watchSelfHeal,
                  notification: toNotificationPayload(watchNotification),
                })}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
              >
                <Play weight="bold" />
                {t("startWatch")}
              </motion.button>
              <motion.button
                className="btn"
                disabled={!watchStopCapability.enabled}
                onClick={() => {
                  if (!window.confirm(t("confirmStopWatch"))) {
                    return;
                  }
                  void props.onStopWatch();
                }}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
              >
                <Stop weight="bold" />
                {t("stopWatch")}
              </motion.button>
            </div>
            {watchStartCapability.reason && <p className="text-muted" style={{ marginTop: "0.5rem", fontSize: "0.75rem" }}>{watchStartCapability.reason}</p>}
          </div>

          <div className="stack-section">
            <h3>{t("hookControls")}</h3>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "0.75rem" }}>
              <Field label={t("hookEvent")} htmlFor="hook-event">
                <input id="hook-event" value={hookEvent} onChange={(event) => setHookEvent(event.target.value)} />
              </Field>
              <Field label={t("hookNotifyMode")} htmlFor="hook-notify-mode">
                <select
                  id="hook-notify-mode"
                  value={hookNotification.mode}
                  onChange={(event) => setHookNotification((current) => ({ ...current, mode: event.target.value as NotificationFormState["mode"] }))}
                >
                  <option value="off">{t("notifyOff")}</option>
                  <option value="exceptional-only">{t("notifyExceptional")}</option>
                  <option value="all">{t("notifyAll")}</option>
                </select>
              </Field>
              <Field label={t("hookNotifyTarget")} htmlFor="hook-notify-target">
                <input
                  id="hook-notify-target"
                  value={hookNotification.to}
                  onChange={(event) => setHookNotification((current) => ({ ...current, to: event.target.value }))}
                  placeholder={t("webhookUrl")}
                />
              </Field>
            </div>
            <div className="btn-row">
              <motion.button
                className="btn btn-primary"
                disabled={!hookInstallCapability.enabled}
                onClick={() => {
                  if (!window.confirm(t("confirmInstallHook"))) {
                    return;
                  }
                  void props.onInstallHook({
                    eventKey: hookEvent,
                    notification: toNotificationPayload(hookNotification),
                  });
                }}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
              >
                <PlugsConnected weight="bold" />
                {t("installHook")}
              </motion.button>
              <motion.button
                className="btn"
                disabled={!hookRemoveCapability.enabled}
                onClick={() => {
                  if (!window.confirm(t("confirmRemoveHook"))) {
                    return;
                  }
                  void props.onRemoveHook();
                }}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
              >
                {t("removeHook")}
              </motion.button>
              <motion.button
                className="btn"
                disabled={!hookRunCapability.enabled}
                onClick={() => void props.onRunHook({ notification: toNotificationPayload(hookNotification) })}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
              >
                <Play weight="bold" />
                {t("runHookNow")}
              </motion.button>
            </div>
            {hookInstallCapability.reason && <p className="text-muted" style={{ marginTop: "0.5rem", fontSize: "0.75rem" }}>{hookInstallCapability.reason}</p>}
          </div>

          {props.actionError && <p className="error-text">{t("actionError")}: {props.actionError}</p>}
          {props.actionState.lastCompleted && <p className="text-muted" style={{ fontSize: "0.75rem" }}>{props.actionState.lastCompleted.summary}</p>}
        </div>
      </Card>

      <Card title={t("watchOrigin")} delay={3}>
        <p className="mono" style={{ fontSize: "0.75rem" }}>{origins.watch?.outputDir ?? t("noData")}</p>
      </Card>
      <Card title={t("hookOrigin")} delay={4}>
        <p className="mono" style={{ fontSize: "0.75rem" }}>{origins.hook?.outputDir ?? t("noData")}</p>
      </Card>
      <Card title={t("manualOrigin")} delay={5}>
        <p className="mono" style={{ fontSize: "0.75rem" }}>{origins.manual?.outputDir ?? t("noData")}</p>
      </Card>
    </div>
  );
}

function AppContent() {
  const { bootstrap, error: bootstrapError } = useConsoleBootstrap();
  const snapshotState = useSnapshot();
  const { actionState, refresh: refreshActionState, setActionState } = useActionState();
  const preferences = usePreferences(bootstrap?.ui.defaultLocale ?? "en", bootstrap?.ui.defaultTheme ?? "dark");
  const { t } = useTranslation();
  const phoenixActions = usePhoenixActions(snapshotState.refresh, setActionState);
  const location = useLocation();
  const previousBusyRef = useRef(false);

  useEffect(() => {
    void i18n.changeLanguage(preferences.locale);
  }, [preferences.locale]);

  useEffect(() => {
    document.title = t("title");
  }, [t, location.pathname]);

  const views = bootstrap?.routes.views ?? ["overview", "setup", "activity", "archives", "configuration"];
  const currentPostureTone = useMemo(() => bootstrap?.posture.requestSource === "remote" ? "warning" : "success", [bootstrap]);

  const refreshAll = async () => {
    snapshotState.refresh();
    await refreshActionState().catch(() => {});
  };

  useEffect(() => {
    const busy = isActionStateBusy(actionState);
    if (!busy && previousBusyRef.current) {
      snapshotState.refresh();
    }
    previousBusyRef.current = busy;
    if (!busy) {
      return;
    }
    const interval = window.setInterval(() => {
      void refreshActionState()
        .then((nextState) => {
          if (!isActionStateBusy(nextState)) {
            snapshotState.refresh();
          }
        })
        .catch(() => {});
    }, ACTION_STATE_POLL_MS);
    return () => window.clearInterval(interval);
  }, [actionState, refreshActionState, snapshotState]);

  if (bootstrapError) {
    return (
      <main className="app-shell">
        <Card title="Bootstrap error">
          <p className="error-text">{bootstrapError}</p>
        </Card>
      </main>
    );
  }

  if (!bootstrap) {
    return (
      <main className="app-shell">
        <Card title={t("title")}>
          <div className="loading-skeleton" style={{ height: "100px" }} />
        </Card>
      </main>
    );
  }

  const routeElements: Record<ConsoleView, ReactNode> = {
    overview: (
      <OverviewPage
        locale={preferences.locale}
        posture={bootstrap.posture}
        snapshot={snapshotState.snapshot}
        actionState={actionState}
        actionError={phoenixActions.error}
        runningAction={phoenixActions.runningAction}
        onBackupNow={async () => {
          await phoenixActions.start("backup-now");
          await refreshActionState().catch(() => {});
        }}
        onHealthCheckNow={async () => {
          await phoenixActions.start("health-check-now");
          await refreshActionState().catch(() => {});
        }}
      />
    ),
    setup: <SetupPage snapshot={snapshotState.snapshot} />,
    activity: <ActivityPage snapshot={snapshotState.snapshot} locale={preferences.locale} />,
    archives: <ArchivesPage snapshot={snapshotState.snapshot} locale={preferences.locale} />,
    configuration: (
      <ConfigurationPage
        locale={preferences.locale}
        bootstrap={bootstrap}
        snapshot={snapshotState.snapshot}
        actionState={actionState}
        actionError={phoenixActions.error}
        onStartWatch={async (input) => {
          await phoenixActions.start("watch-start", input);
          await refreshActionState().catch(() => {});
        }}
        onStopWatch={async () => {
          await phoenixActions.start("watch-stop");
          await refreshActionState().catch(() => {});
        }}
        onInstallHook={async (input) => {
          await phoenixActions.start("hook-install", input);
          await refreshActionState().catch(() => {});
        }}
        onRemoveHook={async () => {
          await phoenixActions.start("hook-remove");
          await refreshActionState().catch(() => {});
        }}
        onRunHook={async (input) => {
          await phoenixActions.start("hook-run", input);
          await refreshActionState().catch(() => {});
        }}
      />
    ),
  };

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <motion.div
          className="brand"
          initial={{ opacity: 0, x: -20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.4 }}
        >
          <h1>{t("title")}</h1>
          <p>{t("subtitle")}</p>
        </motion.div>
        <nav className="nav-list">
          <AnimatePresence>
            {views.map((view, index) => {
              const Icon = viewIcons[view];
              return (
                <motion.div
                  key={view}
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.3, delay: index * 0.05 }}
                >
                  <NavLink
                    to={`/${view}`}
                    className={({ isActive }) => `nav-link ${isActive ? "nav-link--active" : ""}`}
                  >
                    <Icon className="nav-icon" weight="bold" />
                    {t(viewLabels[view])}
                  </NavLink>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </nav>
      </aside>
      <section className="content">
        <motion.header
          className="toolbar"
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.2 }}
        >
          <div className="toolbar-group">
            <span className="toolbar-label">{t("language")}</span>
            <SegmentedControl
              value={preferences.locale}
              onChange={(v) => preferences.setLocale(v as ConsoleLocale)}
              options={[
                { value: "en", label: t("english") },
                { value: "zh-CN", label: t("chinese") },
              ]}
            />
          </div>
          <div className="toolbar-group">
            <span className="toolbar-label">{t("theme")}</span>
            <SegmentedControl
              value={preferences.theme}
              onChange={(v) => preferences.setTheme(v as ConsoleTheme)}
              options={[
                { value: "dark", label: t("dark") },
                { value: "light", label: t("light") },
              ]}
            />
          </div>
          <div className="toolbar-meta">
            <Badge tone={currentPostureTone} pulse>{bootstrap.posture.bindingMode}</Badge>
            <span className="text-muted" style={{ fontSize: "0.8rem" }}>{t("refreshStatus")}: {formatDateTime(preferences.locale, snapshotState.snapshot?.overview.generatedAt)}</span>
            <motion.button
              className="btn"
              onClick={() => void refreshAll()}
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
            >
              <ArrowClockwise weight="bold" />
              {t("refresh")}
            </motion.button>
          </div>
        </motion.header>

        {snapshotState.error && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
          >
            <Card title="Snapshot error">
              <p className="error-text">{snapshotState.error}</p>
            </Card>
          </motion.div>
        )}

        <AnimatePresence mode="wait">
          <motion.div
            key={location.pathname}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <Routes>
              <Route path="/" element={routeElements[bootstrap.routes.defaultView]} />
              {views.map((view) => (
                <Route key={view} path={`/${view}`} element={routeElements[view]} />
              ))}
              <Route path="*" element={<Navigate to={`/${bootstrap.routes.defaultView}`} replace />} />
            </Routes>
          </motion.div>
        </AnimatePresence>
      </section>
    </main>
  );
}

export function PhoenixConsoleApp() {
  return (
    <I18nextProvider i18n={i18n}>
      <BrowserRouter>
        <AppContent />
      </BrowserRouter>
    </I18nextProvider>
  );
}
