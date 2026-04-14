export type ConsoleView = "overview" | "setup" | "activity" | "archives" | "configuration";
export type ConsoleTheme = "dark" | "light";
export type ConsoleLocale = "en" | "zh-CN";

export type ConsoleBootstrap = {
  posture: {
    bindingMode: "loopback-only" | "network-exposed";
    requestSource: "loopback" | "remote" | "unknown";
    manualActionsAvailable: boolean;
    manualActionsDetail: string; // translation key
    mutationGuardSummary: string;
  };
  routes: {
    defaultView: ConsoleView;
    views: ConsoleView[];
  };
  actions: {
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
  ui: {
    defaultLocale: "en";
    supportedLocales: ConsoleLocale[];
    defaultTheme: "dark";
    supportedThemes: ConsoleTheme[];
  };
};

export type PhoenixWebSnapshot = {
  schemaVersion: 1;
  overview: {
    schemaVersion: 1;
    generatedAt: string;
    latestAction?: {
      id: string;
      origin: string;
      operation: string;
      status: "ok" | "warning" | "error";
      summary: string;
      finishedAt: string;
    };
    latestByOrigin: Partial<Record<"watch" | "hook" | "manual", { summary: string; finishedAt: string }>>;
    archiveCount: number;
    latestKnownGoodArchivePath?: string;
    latestBackup?: { finishedAt: string; result: { archivePath?: string; error?: string } };
    latestHealth?: { finishedAt: string; result: { healthy?: boolean; reason?: string } };
    latestRollback?: { finishedAt: string; result: { restored: boolean; needed: boolean; archivePath?: string; error?: string } };
    latestNotification?: { finishedAt: string; result: { status: string; events: unknown[]; delivery: unknown[] } };
  };
  timeline: {
    schemaVersion: 1;
    generatedAt: string;
    entries: Array<{
      id: string;
      origin: string;
      operation: string;
      status: "ok" | "warning" | "error";
      summary: string;
      finishedAt: string;
    }>;
    runs: Array<{
      actionId: string;
      origin: string;
      operation: string;
      status: "ok" | "warning" | "error";
      summary: string;
      finishedAt: string;
      roles: string[];
      stages: Array<{ type: string; status: string; detail: string }>;
    }>;
  };
  config: {
    schemaVersion: 1;
    generatedAt: string;
    deployment?: {
      configPath: string;
      stateDir: string;
      oauthDir: string;
      warnings: string[];
    };
    origins: Partial<Record<"watch" | "hook" | "manual", {
      configPath?: string;
      outputDir: string;
      retain?: number;
      selfHeal?: boolean;
      lastRunAt?: string;
      installed?: boolean;
      eventKey?: string;
      hookDir?: string;
      notification: {
        enabled: boolean;
        policy: string;
        targetConfigured: boolean;
      };
    }>>;
  };
  archives: {
    schemaVersion: 1;
    generatedAt: string;
    latestKnownGoodArchivePath?: string;
    lastBackupArchivePath?: string;
    archives: Array<{
      archivePath: string;
      fileName: string;
      mtimeAt: string;
      sizeBytes: number;
      roles: string[];
    }>;
  };
  setup: {
    schemaVersion: 1;
    generatedAt: string;
    items: Array<{
      id: string;
      section: "environment" | "backup" | "self-heal" | "notifications";
      priority: "required" | "optional" | "advanced";
      severity: "ok" | "info" | "warning" | "blocker";
      title: string;
      summary: string;
      value?: string;
    }>;
    backupReadiness: {
      state: "ready" | "needs-attention" | "blocked";
      title: string;
      summary: string;
    };
    selfHealReadiness: {
      state: "ready" | "needs-attention" | "blocked";
      title: string;
      summary: string;
    };
    commands: Array<{
      id: string;
      title: string;
      summary: string;
      command: string;
      appliesChanges: boolean;
    }>;
  };
};

export type ActionState = {
  runningMutation?: {
    id: string;
    action: "backup-now" | "health-check-now" | "watch-start" | "watch-stop" | "hook-install" | "hook-remove" | "hook-run";
    startedAt: string;
  };
  lastCompleted?: {
    id: string;
    action: "backup-now" | "health-check-now" | "watch-start" | "watch-stop" | "hook-install" | "hook-remove" | "hook-run";
    startedAt: string;
    finishedAt: string;
    status: "ok" | "warning" | "error";
    summary: string;
  };
  watch: {
    status: "stopped" | "starting" | "running" | "stopping" | "error";
    startedAt?: string;
    stoppedAt?: string;
    selfHeal?: boolean;
    notification?: {
      enabled: boolean;
      policy: "off" | "exceptional-only" | "all";
      target?: {
        to?: string;
        channel?: string;
        accountId?: string;
        threadId?: string;
      };
    };
    lastError?: string;
  };
  capabilities: Record<
    "backup-now" | "health-check-now" | "watch-start" | "watch-stop" | "hook-install" | "hook-remove" | "hook-run",
    { enabled: boolean; reason?: string }
  >;
};
