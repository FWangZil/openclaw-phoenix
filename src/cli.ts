#!/usr/bin/env -S node --import tsx
import process from "node:process";
import { Command, InvalidArgumentError } from "commander";
import { installPhoenixHook, removePhoenixHook, DEFAULT_HOOK_EVENT } from "./hook-install.js";
import { runPhoenixHook } from "./hook-run.js";
import {
  formatPhoenixDoctorReport,
  runPhoenixDoctor,
} from "./doctor.js";
import {
  parsePhoenixNotificationMode,
  resolvePhoenixNotificationConfig,
  type PhoenixNotificationMode,
} from "./notify.js";
import { DEFAULT_OPENCLAW_BIN, DEFAULT_OUTPUT_DIR, resolveOutputDir, resolveUserPath } from "./paths.js";
import { formatShellCommand, resolvePhoenixCommand } from "./phoenix-command.js";
import { restoreBackupArchive } from "./restore.js";
import { DEFAULT_DEBOUNCE_MS, DEFAULT_RETAIN, startBackupWatch } from "./watch.js";
import { createPhoenixWebActionController } from "./web-actions.js";
import { derivePhoenixWebConsoleSurfacePosture, startPhoenixWebConsole } from "./web-console.js";
import { buildPhoenixWebSnapshot } from "./web-contract.js";

function parsePositiveInteger(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError(`${label} must be a positive integer`);
  }
  return parsed;
}

function parsePort(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new InvalidArgumentError("port must be an integer between 0 and 65535");
  }
  return parsed;
}

type NotificationOptionShape = {
  notify?: PhoenixNotificationMode;
  notifyTarget?: string;
  notifyChannel?: string;
  notifyAccount?: string;
  notifyThreadId?: string;
};

function addNotificationOptions(command: Command, options: { modeHelp?: string } = {}): Command {
  return command
    .option(
      "--notify <mode>",
      options.modeHelp ?? "Notification mode for shared recovery summaries (off|exceptional-only|all)",
      parsePhoenixNotificationMode,
      "off",
    )
    .option("--notify-target <target>", "OpenClaw send target (required for remote notification delivery)")
    .option("--notify-channel <channel>", "Optional OpenClaw send channel override")
    .option("--notify-account <id>", "Optional OpenClaw send account override")
    .option("--notify-thread-id <id>", "Optional OpenClaw send thread identifier");
}

function resolveNotificationFromOptions(options: NotificationOptionShape) {
  return resolvePhoenixNotificationConfig({
    mode: options.notify,
    target: {
      to: options.notifyTarget,
      channel: options.notifyChannel,
      accountId: options.notifyAccount,
      threadId: options.notifyThreadId,
    },
  });
}

async function main() {
  const program = new Command();
  program.name("openclaw-phoenix").description("Standalone OpenClaw backup watch + retention CLI");
  const doctorCommand = program
    .command("doctor")
    .description("Check local/runtime prerequisites before relying on Phoenix self-heal")
    .option("--config <path>", "Override OPENCLAW_CONFIG_PATH when resolving the deployment to inspect")
    .option("--openclaw-bin <path>", "Path to the deployed openclaw binary", DEFAULT_OPENCLAW_BIN)
    .option("--output <dir>", "Directory Phoenix should use for backup archives and state", DEFAULT_OUTPUT_DIR)
    .option("--json", "Print the doctor report as JSON", false);
  addNotificationOptions(doctorCommand, {
    modeHelp: "Notification mode to validate for the self-heal send path (off|exceptional-only|all)",
  }).action(async (options) => {
    const report = await runPhoenixDoctor({
      configPath: options.config ? resolveUserPath(options.config) : undefined,
      openclawBin: options.openclawBin,
      outputDir: resolveOutputDir(options.output),
      notification: resolveNotificationFromOptions(options),
    });
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatPhoenixDoctorReport(report));
    }
    if (!report.ok) {
      process.exitCode = 1;
    }
  });
  program
    .command("restore <archive>")
    .description("Restore a verified OpenClaw backup archive into the current deployment paths")
    .option("--config <path>", "Override OPENCLAW_CONFIG_PATH when resolving Phoenix restore targets")
    .option("--openclaw-bin <path>", "Path to the deployed openclaw binary", DEFAULT_OPENCLAW_BIN)
    .option("--dry-run", "Validate and print the restore plan without writing any files", false)
    .option("-y, --yes", "Skip the interactive confirmation prompt", false)
    .action(async (archive, options) => {
      await restoreBackupArchive({
        archivePath: resolveUserPath(archive),
        configPath: options.config ? resolveUserPath(options.config) : undefined,
        dryRun: Boolean(options.dryRun),
        openclawBin: options.openclawBin,
        yes: Boolean(options.yes),
      });
    });
  addNotificationOptions(
    program
      .command("watch")
      .description("Watch OpenClaw config and credential stores, then trigger backup retention cycles (backup-only by default)")
      .option("--config <path>", "Override OPENCLAW_CONFIG_PATH for both watcher resolution and spawned backups")
      .option("--openclaw-bin <path>", "Path to the deployed openclaw binary", DEFAULT_OPENCLAW_BIN)
      .option("--output <dir>", "Directory for watched backup archives", DEFAULT_OUTPUT_DIR)
      .option("--retain <count>", "How many recent archives to keep", (value) => parsePositiveInteger(value, "retain"), DEFAULT_RETAIN)
      .option("--debounce-ms <ms>", "Debounce window before running backup", (value) => parsePositiveInteger(value, "debounce-ms"), DEFAULT_DEBOUNCE_MS)
      .option("--self-heal", "Opt in to running the shared status/rollback recovery flow after each settled watch cycle", false),
    { modeHelp: "Notification mode for shared recovery summaries (watch requires --self-heal; off|exceptional-only|all)" },
  ).action(async (options) => {
    const session = await startBackupWatch({
      configPath: options.config ? resolveUserPath(options.config) : undefined,
      debounceMs: options.debounceMs,
      openclawBin: options.openclawBin,
      outputDir: resolveOutputDir(options.output),
      retain: options.retain,
      selfHeal: Boolean(options.selfHeal),
      notification: resolveNotificationFromOptions(options),
    });
    let shuttingDown = false;
    const shutdown = async (signal: string) => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      console.log(`received ${signal}; stopping watch`);
      await session.close();
      process.exit(0);
    };
    process.once("SIGINT", () => {
      void shutdown("SIGINT");
    });
    process.once("SIGTERM", () => {
      void shutdown("SIGTERM");
    });
    await session.closed;
  });
  const hook = program.command("hook").description("Install or run the managed OpenClaw Phoenix hook");
  addNotificationOptions(
    hook
      .command("install")
      .description("Install the managed OpenClaw hook that triggers backup/status/rollback")
      .option("--config <path>", "Override OPENCLAW_CONFIG_PATH when updating the deployed OpenClaw config")
      .option("--openclaw-bin <path>", "Path to the deployed openclaw binary that the hook should invoke", DEFAULT_OPENCLAW_BIN)
      .option("--phoenix-bin <path>", "Path to the openclaw-phoenix executable or CLI entrypoint to invoke from the hook")
      .option("--output <dir>", "Directory for Phoenix hook backup archives", DEFAULT_OUTPUT_DIR)
      .option("--retain <count>", "How many recent archives to keep", (value) => parsePositiveInteger(value, "retain"), DEFAULT_RETAIN)
      .option("--event <event>", "OpenClaw internal hook event key to subscribe to", DEFAULT_HOOK_EVENT),
  ).action(async (options) => {
    const phoenixCommand = resolvePhoenixCommand({
      phoenixBin: options.phoenixBin,
      argv: process.argv,
    });
    const result = await installPhoenixHook({
      configPath: options.config ? resolveUserPath(options.config) : undefined,
      phoenixCommand,
      openclawBin: options.openclawBin,
      outputDir: resolveOutputDir(options.output),
      retain: options.retain,
      eventKey: options.event,
      notification: resolveNotificationFromOptions(options),
    });
    console.log(`installed ${result.eventKey} -> ${result.hookDir}`);
    console.log(`updated ${result.configPath}`);
    console.log(`handler command: ${formatShellCommand(phoenixCommand)}`);
  });
  hook
    .command("remove")
    .description("Remove the managed OpenClaw Phoenix hook without disturbing unrelated hooks")
    .option("--config <path>", "Override OPENCLAW_CONFIG_PATH when updating the deployed OpenClaw config")
    .action(async (options) => {
      const result = await removePhoenixHook({
        configPath: options.config ? resolveUserPath(options.config) : undefined,
      });
      console.log(`removed ${result.hookDir}`);
      console.log(`updated ${result.configPath}`);
    });
  addNotificationOptions(
    hook
      .command("run")
      .description("Internal: run the backup/status/rollback flow used by the managed hook")
      .option("--config <path>", "Override OPENCLAW_CONFIG_PATH when running the Phoenix hook flow")
      .option("--openclaw-bin <path>", "Path to the deployed openclaw binary", DEFAULT_OPENCLAW_BIN)
      .option("--output <dir>", "Directory for hook backup archives", DEFAULT_OUTPUT_DIR)
      .option("--retain <count>", "How many recent archives to keep", (value) => parsePositiveInteger(value, "retain"), DEFAULT_RETAIN)
      .option("--json", "Print the hook run summary as JSON", false),
  ).action(async (options) => {
    const result = await runPhoenixHook({
      configPath: options.config ? resolveUserPath(options.config) : undefined,
      openclawBin: options.openclawBin,
      outputDir: resolveOutputDir(options.output),
      retain: options.retain,
      notification: resolveNotificationFromOptions(options),
    });
    if (options.json) {
      console.log(JSON.stringify(result));
    } else {
      console.log(`backup: ${result.backedUpArchivePath ?? "not created"}`);
      console.log(`health: ${result.healthy ? "healthy" : "unhealthy"} (${result.healthReason})`);
      if (result.latestKnownGoodArchivePath) {
        console.log(`latest-known-good: ${result.latestKnownGoodArchivePath}`);
      }
      if (result.notification) {
        console.log(result.notification);
      }
    }
    if (!result.ok) {
      process.exitCode = 1;
    }
  });
  const web = program
    .command("web")
    .description("Structured read models and a local-first Phoenix web console");
  web
    .command("snapshot")
    .description("Print the current overview, timeline, config, and archive contract as JSON")
    .option("--config <path>", "Override OPENCLAW_CONFIG_PATH when resolving Phoenix deployment paths")
    .option("--output <dir>", "Directory for Phoenix backup archives and state", DEFAULT_OUTPUT_DIR)
    .option(
      "--timeline-limit <count>",
      "How many recent timeline entries to include",
      (value) => parsePositiveInteger(value, "timeline-limit"),
      20,
    )
    .action(async (options) => {
      const snapshot = await buildPhoenixWebSnapshot({
        configPath: options.config ? resolveUserPath(options.config) : undefined,
        env: process.env,
        outputDir: resolveOutputDir(options.output),
        timelineLimit: options.timelineLimit,
      });
      console.log(JSON.stringify(snapshot));
    });
  web
    .command("serve")
    .description("Serve the local Phoenix Web console with low-risk manual actions")
    .option("--config <path>", "Override OPENCLAW_CONFIG_PATH when resolving Phoenix deployment paths")
    .option("--openclaw-bin <path>", "Path to the deployed openclaw binary for browser-triggered actions", DEFAULT_OPENCLAW_BIN)
    .option("--output <dir>", "Directory for Phoenix backup archives and state", DEFAULT_OUTPUT_DIR)
    .option("--host <host>", "Host interface to bind for the local Phoenix console", "127.0.0.1")
    .option("--port <port>", "Port for the local Phoenix console (0 = random available port)", parsePort, 48789)
    .option("--dev-origin <origin>", "Absolute Vite dev-server origin to use for HMR assets instead of dist/web")
    .option(
      "--timeline-limit <count>",
      "How many recent timeline entries to include in the Phoenix web console",
      (value) => parsePositiveInteger(value, "timeline-limit"),
      50,
    )
    .action(async (options) => {
      const configPath = options.config ? resolveUserPath(options.config) : undefined;
      const outputDir = resolveOutputDir(options.output);
      const loadSnapshot = async () => buildPhoenixWebSnapshot({
        configPath,
        env: process.env,
        outputDir,
        timelineLimit: options.timelineLimit,
      });
      const server = await startPhoenixWebConsole({
        host: options.host,
        port: options.port,
        devAssetOrigin: options.devOrigin,
        actionController: createPhoenixWebActionController({
          configPath,
          openclawBin: options.openclawBin,
          outputDir,
          retain: DEFAULT_RETAIN,
          phoenixCommand: resolvePhoenixCommand({
            argv: process.argv,
          }),
          loadSnapshot,
        }),
        loadSnapshot,
      });
      const posture = derivePhoenixWebConsoleSurfacePosture({ bindHost: options.host, defaultToLoopbackRequest: true });
      console.log(`Phoenix web console listening at ${server.url}`);
      if (posture.bindingMode === "network-exposed") {
        console.log("Warning: this bind reaches beyond loopback. Phoenix Web v1 is not a remote admin panel.");
        console.log("Manual browser actions still require a same-machine loopback session; use the Phoenix host's own browser for backup-now and health-check-now.");
      } else {
        console.log("Manual browser actions stay loopback-local and require same-origin requests from the Phoenix console itself.");
      }
      console.log("Press Ctrl+C to stop.");
      let shuttingDown = false;
      const shutdown = async (signal: string) => {
        if (shuttingDown) {
          return;
        }
        shuttingDown = true;
        console.log(`received ${signal}; stopping web console`);
        await server.close();
        process.exit(0);
      };
      process.once("SIGINT", () => {
        void shutdown("SIGINT");
      });
      process.once("SIGTERM", () => {
        void shutdown("SIGTERM");
      });
      await server.closed;
    });
  await program.parseAsync(process.argv);
}

void main().catch((error) => {
  console.error(String(error));
  process.exit(1);
});
