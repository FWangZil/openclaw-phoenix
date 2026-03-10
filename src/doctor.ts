import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { PhoenixNotificationConfig } from "./notify.js";
import { resolveWatchPlan } from "./watch-plan.js";

type PhoenixDoctorSection = "environment" | "backup" | "self-heal" | "notifications";
type PhoenixDoctorSeverity = "ok" | "info" | "warning" | "blocker";
type PhoenixDoctorReadinessState = "ready" | "needs-attention" | "blocked";

type OpenClawDoctorStatus = {
  gateway?: {
    reachable?: boolean;
    misconfigured?: boolean;
    error?: string | null;
    url?: string | null;
    connectLatencyMs?: number | null;
    authWarning?: string | null;
    [key: string]: unknown;
  };
};

type PhoenixDoctorItem = {
  id: string;
  section: PhoenixDoctorSection;
  severity: PhoenixDoctorSeverity;
  title: string;
  summary: string;
  value?: string;
  fixHint?: string;
};

type PhoenixDoctorReadiness = {
  state: PhoenixDoctorReadinessState;
  title: string;
  summary: string;
};

export type PhoenixDoctorReport = {
  generatedAt: string;
  ok: boolean;
  items: PhoenixDoctorItem[];
  backupReadiness: PhoenixDoctorReadiness;
  selfHealReadiness: PhoenixDoctorReadiness;
  nextSteps: string[];
};

type PhoenixDoctorRequest = {
  configPath?: string;
  openclawBin: string;
  outputDir: string;
  env?: NodeJS.ProcessEnv;
  notification?: PhoenixNotificationConfig;
  timeoutMs?: number;
};

type CommandProbeResult = {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: string;
  errorCode?: string;
  timedOut: boolean;
};

const DEFAULT_DOCTOR_TIMEOUT_MS = 5_000;

const SECTION_TITLES: Record<PhoenixDoctorSection, string> = {
  environment: "Environment",
  backup: "Backup",
  "self-heal": "Self-heal",
  notifications: "Notifications",
};

function renderSeverity(severity: PhoenixDoctorSeverity): string {
  return severity === "blocker"
    ? "BLOCKER"
    : severity === "warning"
      ? "WARNING"
      : severity === "info"
        ? "INFO"
        : "OK";
}

function renderReadinessState(state: PhoenixDoctorReadinessState): string {
  return state === "ready" ? "READY" : state === "needs-attention" ? "NEEDS ATTENTION" : "BLOCKED";
}

function formatCommandError(result: CommandProbeResult): string {
  if (result.timedOut) {
    return result.error ?? "timed out";
  }
  if (result.error) {
    return result.error;
  }
  if (result.stderr) {
    return result.stderr;
  }
  if (result.stdout) {
    return result.stdout;
  }
  if (result.exitCode !== null) {
    return `exited with code ${result.exitCode}`;
  }
  return "unknown failure";
}

async function pathStat(targetPath: string) {
  return await fs.stat(targetPath).catch(() => null);
}

async function hasAccess(targetPath: string, mode: number): Promise<boolean> {
  return await fs.access(targetPath, mode).then(() => true).catch(() => false);
}

async function findNearestExistingParent(targetPath: string): Promise<string | undefined> {
  let current = path.resolve(targetPath);
  while (true) {
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    const stat = await pathStat(parent);
    if (stat?.isDirectory()) {
      return parent;
    }
    current = parent;
  }
}

async function runCommandProbe(options: {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
}): Promise<CommandProbeResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const child = spawn(options.command, options.args, {
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  return await new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    const finish = (result: CommandProbeResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, Math.max(250, options.timeoutMs));
    child.once("error", (error: NodeJS.ErrnoException) => {
      finish({
        ok: false,
        exitCode: null,
        stdout: stdout.join("").trim(),
        stderr: stderr.join("").trim(),
        error: error.message,
        errorCode: error.code,
        timedOut,
      });
    });
    child.once("exit", (code, signal) => {
      const stdoutText = stdout.join("").trim();
      const stderrText = stderr.join("").trim();
      if (timedOut) {
        finish({
          ok: false,
          exitCode: code,
          stdout: stdoutText,
          stderr: stderrText,
          error: `timed out after ${options.timeoutMs}ms`,
          timedOut: true,
        });
        return;
      }
      if (signal) {
        finish({
          ok: false,
          exitCode: code,
          stdout: stdoutText,
          stderr: stderrText,
          error: `exited via signal ${signal}`,
          timedOut: false,
        });
        return;
      }
      finish({
        ok: code === 0,
        exitCode: code,
        stdout: stdoutText,
        stderr: stderrText,
        timedOut: false,
      });
    });
  });
}

function buildReadiness(options: {
  items: PhoenixDoctorItem[];
  sections: PhoenixDoctorSection[];
  readyTitle: string;
  readySummary: string;
  warningTitle: string;
  warningSummary: string;
  blockedTitle: string;
  blockedSummary: string;
}): PhoenixDoctorReadiness {
  const relevant = options.items.filter((item) => options.sections.includes(item.section));
  if (relevant.some((item) => item.severity === "blocker")) {
    return {
      state: "blocked",
      title: options.blockedTitle,
      summary: options.blockedSummary,
    };
  }
  if (relevant.some((item) => item.severity === "warning")) {
    return {
      state: "needs-attention",
      title: options.warningTitle,
      summary: options.warningSummary,
    };
  }
  return {
    state: "ready",
    title: options.readyTitle,
    summary: options.readySummary,
  };
}

function collectNextSteps(items: PhoenixDoctorItem[]): string[] {
  const deduped = new Set<string>();
  for (const item of items) {
    if ((item.severity === "blocker" || item.severity === "warning") && item.fixHint) {
      deduped.add(item.fixHint);
    }
  }
  return [...deduped];
}

export async function runPhoenixDoctor(options: PhoenixDoctorRequest): Promise<PhoenixDoctorReport> {
  const generatedAt = new Date().toISOString();
  const timeoutMs = options.timeoutMs ?? DEFAULT_DOCTOR_TIMEOUT_MS;
  const effectiveEnv = options.configPath
    ? { ...process.env, ...options.env, OPENCLAW_CONFIG_PATH: options.configPath }
    : (options.env ?? process.env);
  const plan = await resolveWatchPlan({ configPath: options.configPath, env: effectiveEnv });
  const items: PhoenixDoctorItem[] = [];
  const addItem = (item: PhoenixDoctorItem) => items.push(item);

  const binaryProbe = await runCommandProbe({
    command: options.openclawBin,
    args: ["--help"],
    env: effectiveEnv,
    timeoutMs,
  });
  const binaryHasPath = /[\\/]/u.test(options.openclawBin);
  const binaryReady = binaryProbe.ok;
  addItem(binaryProbe.ok
    ? {
        id: "openclaw-bin",
        section: "environment",
        severity: "ok",
        title: "OpenClaw binary",
        summary: "Phoenix can execute the configured openclaw CLI.",
        value: options.openclawBin,
      }
    : {
        id: "openclaw-bin",
        section: "environment",
        severity: "blocker",
        title: "OpenClaw binary",
        summary: binaryProbe.errorCode === "ENOENT"
          ? binaryHasPath
            ? "The configured openclaw path does not exist."
            : "Phoenix could not find openclaw on PATH."
          : binaryProbe.errorCode === "EACCES"
            ? "The configured openclaw path exists, but the current user cannot execute it."
            : `Phoenix could not execute openclaw: ${formatCommandError(binaryProbe)}`,
        value: options.openclawBin,
        fixHint: binaryHasPath
          ? "Point --openclaw-bin at the deployed openclaw executable and ensure it has execute permission."
          : "Install openclaw on PATH or pass --openclaw-bin <path> to the deployed executable.",
      });

  const configStat = await pathStat(plan.rootConfigPath);
  if (!configStat) {
    addItem({
      id: "config-path",
      section: "environment",
      severity: "blocker",
      title: "OpenClaw config path",
      summary: "Phoenix resolved a deployment config path, but the file is not present yet.",
      value: plan.rootConfigPath,
      fixHint: "Create the active openclaw.json at this path or rerun Phoenix with --config <path>.",
    });
  } else if (!configStat.isFile()) {
    addItem({
      id: "config-path",
      section: "environment",
      severity: "blocker",
      title: "OpenClaw config path",
      summary: "The resolved config path exists, but it is not a file.",
      value: plan.rootConfigPath,
      fixHint: "Point --config at the active openclaw.json file.",
    });
  } else if (!await hasAccess(plan.rootConfigPath, fsConstants.R_OK)) {
    addItem({
      id: "config-path",
      section: "environment",
      severity: "blocker",
      title: "OpenClaw config path",
      summary: "The current user cannot read the resolved deployment config file.",
      value: plan.rootConfigPath,
      fixHint: "Fix file permissions or rerun Phoenix under a user that can read the deployment config.",
    });
  } else {
    addItem({
      id: "config-path",
      section: "environment",
      severity: "ok",
      title: "OpenClaw config path",
      summary: "Phoenix can read the root deployment config.",
      value: plan.rootConfigPath,
    });
  }

  const stateStat = await pathStat(plan.stateDir);
  if (!stateStat) {
    addItem({
      id: "state-dir",
      section: "environment",
      severity: "blocker",
      title: "OpenClaw state directory",
      summary: "The resolved state directory does not exist yet.",
      value: plan.stateDir,
      fixHint: "Create the OpenClaw state directory or point Phoenix at the active deployment config/state path.",
    });
  } else if (!stateStat.isDirectory()) {
    addItem({
      id: "state-dir",
      section: "environment",
      severity: "blocker",
      title: "OpenClaw state directory",
      summary: "The resolved state path exists, but it is not a directory.",
      value: plan.stateDir,
      fixHint: "Point Phoenix at the deployment whose state path is a directory.",
    });
  } else if (!await hasAccess(plan.stateDir, fsConstants.R_OK | fsConstants.X_OK)) {
    addItem({
      id: "state-dir",
      section: "environment",
      severity: "blocker",
      title: "OpenClaw state directory",
      summary: "The current user cannot inspect the deployment state directory.",
      value: plan.stateDir,
      fixHint: "Fix directory permissions so Phoenix can inspect the deployment state and hook files.",
    });
  } else if (!await hasAccess(plan.stateDir, fsConstants.W_OK | fsConstants.X_OK)) {
    addItem({
      id: "state-dir",
      section: "environment",
      severity: "warning",
      title: "OpenClaw state directory",
      summary: "Phoenix can read the deployment state directory, but the current user cannot write there.",
      value: plan.stateDir,
      fixHint: "Fix directory ownership or permissions before relying on hook updates or other stateful runtime changes.",
    });
  } else {
    addItem({
      id: "state-dir",
      section: "environment",
      severity: "ok",
      title: "OpenClaw state directory",
      summary: "Phoenix can inspect and update the deployment state directory.",
      value: plan.stateDir,
    });
  }

  const outputStat = await pathStat(options.outputDir);
  if (outputStat?.isDirectory()) {
    addItem(await hasAccess(options.outputDir, fsConstants.W_OK | fsConstants.X_OK)
      ? {
          id: "output-dir",
          section: "backup",
          severity: "ok",
          title: "Backup output directory",
          summary: "Phoenix can write backup archives into the configured output directory.",
          value: options.outputDir,
        }
      : {
          id: "output-dir",
          section: "backup",
          severity: "blocker",
          title: "Backup output directory",
          summary: "The output directory exists, but the current user cannot write new archives there.",
          value: options.outputDir,
          fixHint: "Fix directory ownership or choose an --output path that the current user can write.",
        });
  } else if (outputStat) {
    addItem({
      id: "output-dir",
      section: "backup",
      severity: "blocker",
      title: "Backup output directory",
      summary: "The configured output path exists, but it is not a directory.",
      value: options.outputDir,
      fixHint: "Point --output at a directory path Phoenix can use for archives and state.",
    });
  } else {
    const parent = await findNearestExistingParent(options.outputDir);
    const parentWritable = parent ? await hasAccess(parent, fsConstants.W_OK | fsConstants.X_OK) : false;
    addItem({
      id: "output-dir",
      section: "backup",
      severity: parentWritable ? "info" : "blocker",
      title: "Backup output directory",
      summary: parentWritable
        ? "Phoenix can auto-create this output directory on first backup or self-heal run."
        : "Phoenix cannot auto-create this output directory because no writable parent directory is available.",
      value: options.outputDir,
      fixHint: parentWritable
        ? "Optional: pre-create the output directory if you want to confirm ownership before the first Phoenix run."
        : "Choose an --output path with a writable parent directory or pre-create the directory with the correct ownership.",
    });
  }

  if (plan.warnings.length > 0) {
    addItem({
      id: "watch-plan-warnings",
      section: "environment",
      severity: "warning",
      title: "Config-derived watch targets",
      summary: plan.warnings.join(" "),
      fixHint: "Fix the config/include/auth-store warning above so Phoenix can monitor the full intended deployment footprint.",
    });
  } else {
    addItem({
      id: "watch-plan-warnings",
      section: "environment",
      severity: "ok",
      title: "Config-derived watch targets",
      summary: "Phoenix resolved config-derived watch targets without warnings.",
    });
  }

  let parsedStatus: OpenClawDoctorStatus | undefined;
  if (!binaryReady) {
    addItem({
      id: "gateway-connectivity",
      section: "self-heal",
      severity: "info",
      title: "Gateway connectivity",
      summary: "Phoenix could not check gateway reachability because the openclaw binary is not currently executable.",
      fixHint: "Fix the openclaw binary check first, then rerun doctor to verify gateway reachability.",
    });
    addItem({
      id: "gateway-auth",
      section: "self-heal",
      severity: "info",
      title: "Gateway auth prerequisites",
      summary: "Phoenix could not inspect gateway auth warnings because openclaw status did not run.",
    });
  } else {
    const statusProbe = await runCommandProbe({
      command: options.openclawBin,
      args: ["status", "--json"],
      env: effectiveEnv,
      timeoutMs,
    });
    if (!statusProbe.ok) {
      addItem({
        id: "gateway-connectivity",
        section: "self-heal",
        severity: "blocker",
        title: "Gateway connectivity",
        summary: `openclaw status --json failed: ${formatCommandError(statusProbe)}`,
        fixHint: "Run openclaw status --json directly with the same config and fix that runtime problem before enabling self-heal.",
      });
      addItem({
        id: "gateway-auth",
        section: "self-heal",
        severity: "info",
        title: "Gateway auth prerequisites",
        summary: "Phoenix could not inspect gateway auth warnings because openclaw status did not complete successfully.",
      });
    } else {
      try {
        parsedStatus = JSON.parse(statusProbe.stdout) as OpenClawDoctorStatus;
      } catch (error) {
        addItem({
          id: "gateway-connectivity",
          section: "self-heal",
          severity: "blocker",
          title: "Gateway connectivity",
          summary: `openclaw status --json returned invalid JSON: ${String(error)}`,
          fixHint: "Run openclaw status --json directly and fix the underlying runtime problem before enabling self-heal.",
        });
        addItem({
          id: "gateway-auth",
          section: "self-heal",
          severity: "info",
          title: "Gateway auth prerequisites",
          summary: "Phoenix could not inspect gateway auth warnings because status output was invalid.",
        });
      }
    }
  }

  if (parsedStatus) {
    const gateway = parsedStatus.gateway;
    addItem(gateway?.misconfigured === true
      ? {
          id: "gateway-connectivity",
          section: "self-heal",
          severity: "blocker",
          title: "Gateway connectivity",
          summary: "openclaw status reports the gateway as misconfigured.",
          value: gateway.url ?? undefined,
          fixHint: "Fix gateway configuration until openclaw status --json reports gateway.misconfigured=false and gateway.reachable=true.",
        }
      : gateway?.reachable === true
        ? {
            id: "gateway-connectivity",
            section: "self-heal",
            severity: "ok",
            title: "Gateway connectivity",
            summary: `openclaw status reports the gateway as reachable${typeof gateway.connectLatencyMs === "number" ? ` (${gateway.connectLatencyMs}ms)` : ""}.`,
            value: gateway.url ?? undefined,
          }
        : {
            id: "gateway-connectivity",
            section: "self-heal",
            severity: "blocker",
            title: "Gateway connectivity",
            summary: gateway?.error
              ? `openclaw status reports the gateway as unreachable: ${gateway.error}`
              : "openclaw status did not report gateway.reachable=true.",
            value: gateway?.url ?? undefined,
            fixHint: "Fix gateway reachability until openclaw status --json reports gateway.reachable=true before relying on self-heal.",
          });
    addItem(gateway?.authWarning
      ? {
          id: "gateway-auth",
          section: "self-heal",
          severity: "warning",
          title: "Gateway auth prerequisites",
          summary: `openclaw status reported an auth warning: ${gateway.authWarning}`,
          fixHint: "Clear the gateway auth warning from openclaw status before depending on remote self-heal checks.",
        }
      : {
          id: "gateway-auth",
          section: "self-heal",
          severity: gateway?.reachable === true ? "ok" : "info",
          title: "Gateway auth prerequisites",
          summary: gateway?.reachable === true
            ? "openclaw status did not report any gateway auth warnings."
            : "Phoenix could not confirm gateway auth readiness because reachability is not yet healthy.",
        });
  }

  const notificationEnabled = options.notification?.enabled === true;
  const notificationTarget = options.notification?.target?.to?.trim();
  const routingHints = [
    options.notification?.target?.channel,
    options.notification?.target?.accountId,
    options.notification?.target?.threadId,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);

  addItem({
    id: "notification-mode",
    section: "notifications",
    severity: notificationEnabled ? "ok" : "info",
    title: "Notification mode",
    summary: notificationEnabled
      ? `Phoenix is configured to attempt ${options.notification?.policy} notification delivery from self-heal runs.`
      : "Notifications are off. Phoenix can still protect locally without remote delivery.",
    value: notificationEnabled ? options.notification?.policy : "off",
  });

  addItem(!notificationEnabled
    ? {
        id: "notification-target",
        section: "notifications",
        severity: "info",
        title: "Notification target",
        summary: routingHints.length > 0
          ? "Notification routing hints are present, but notifications are off so Phoenix will not attempt remote delivery."
          : "No remote target is required while notifications stay off.",
        value: routingHints.join(" • ") || undefined,
      }
    : notificationTarget
      ? {
          id: "notification-target",
          section: "notifications",
          severity: "ok",
          title: "Notification target",
          summary: "Phoenix has a concrete send target for the supported self-heal notification path.",
          value: notificationTarget,
        }
      : {
          id: "notification-target",
          section: "notifications",
          severity: "warning",
          title: "Notification target",
          summary: routingHints.length > 0
            ? "Notification mode is enabled, but --notify-target is missing, so openclaw gateway call send has no recipient and the routing hints will not help."
            : "Notification mode is enabled, but --notify-target is missing, so Phoenix will skip remote delivery.",
          value: routingHints.join(" • ") || undefined,
          fixHint: "Pass --notify-target <target> with the same --notify mode you intend to use for self-heal runs.",
        });

  const backupReadiness = buildReadiness({
    items,
    sections: ["environment", "backup"],
    readyTitle: "Backup-only readiness is clear",
    readySummary: "Phoenix has what it needs for backup creation and retention coverage.",
    warningTitle: "Backup-only readiness has warnings",
    warningSummary: "Phoenix can run backup-only coverage, but you should review the remaining warnings.",
    blockedTitle: "Backup-only readiness is blocked",
    blockedSummary: "Resolve the hard blockers before relying on Phoenix backups.",
  });
  const selfHealReadiness = buildReadiness({
    items,
    sections: ["environment", "backup", "self-heal", "notifications"],
    readyTitle: "Self-heal readiness is clear",
    readySummary: "Phoenix has the visible local/runtime prerequisites needed for self-heal checks.",
    warningTitle: "Self-heal readiness has warnings",
    warningSummary: "Phoenix can reach a self-heal path, but you should review the remaining warnings before depending on it.",
    blockedTitle: "Self-heal readiness is blocked",
    blockedSummary: "Resolve the hard blockers before relying on Phoenix self-heal.",
  });

  return {
    generatedAt,
    ok: !items.some((item) => item.severity === "blocker"),
    items,
    backupReadiness,
    selfHealReadiness,
    nextSteps: collectNextSteps(items),
  };
}

export function formatPhoenixDoctorReport(report: PhoenixDoctorReport): string {
  const lines = [
    "OpenClaw Phoenix doctor",
    "",
    `Backup-only readiness: ${renderReadinessState(report.backupReadiness.state)}`,
    `  ${report.backupReadiness.summary}`,
    `Self-heal readiness: ${renderReadinessState(report.selfHealReadiness.state)}`,
    `  ${report.selfHealReadiness.summary}`,
  ];
  for (const section of Object.keys(SECTION_TITLES) as PhoenixDoctorSection[]) {
    const sectionItems = report.items.filter((item) => item.section === section);
    if (sectionItems.length === 0) {
      continue;
    }
    lines.push("", `${SECTION_TITLES[section]}:`);
    for (const item of sectionItems) {
      lines.push(`- [${renderSeverity(item.severity)}] ${item.title}`);
      lines.push(`  ${item.summary}`);
      if (item.value) {
        lines.push(`  Current value: ${item.value}`);
      }
      if ((item.severity === "blocker" || item.severity === "warning") && item.fixHint) {
        lines.push(`  Next step: ${item.fixHint}`);
      }
    }
  }
  if (report.nextSteps.length > 0) {
    lines.push("", "Suggested next steps:");
    for (const step of report.nextSteps) {
      lines.push(`- ${step}`);
    }
  }
  lines.push(
    "",
    report.ok
      ? "Doctor result: ready to proceed."
      : "Doctor result: blockers found. Resolve them before relying on Phoenix self-heal.",
  );
  return lines.join("\n");
}