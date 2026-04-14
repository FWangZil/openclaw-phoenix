import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { afterEach, describe, expect, it } from "vitest";
import type { BackupWatchSession } from "./watch.js";
import { startBackupWatch } from "./watch.js";
import { buildPhoenixWebSnapshot } from "./web-contract.js";

const tempDirs: string[] = [];
const sessions: BackupWatchSession[] = [];

async function makeTempDir(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function fileExists(targetPath: string) {
  return Boolean(await fs.stat(targetPath).catch(() => null));
}

async function writeExecutableScript(scriptPath: string, body: string) {
  await fs.writeFile(scriptPath, body, { encoding: "utf8", mode: 0o755 });
}

async function buildArchiveFixture(options: {
  archiveRoot: string;
  manifest: Record<string, unknown>;
  files: Array<{ archivePath: string; contents: string }>;
}) {
  const tempDir = await makeTempDir("phoenix-watch-archive-");
  const rootDir = path.join(tempDir, options.archiveRoot);
  await fs.mkdir(rootDir, { recursive: true });
  await fs.writeFile(path.join(rootDir, "manifest.json"), `${JSON.stringify(options.manifest, null, 2)}\n`, "utf8");
  for (const file of options.files) {
    const targetPath = path.join(tempDir, file.archivePath);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, file.contents, "utf8");
  }
  const archivePath = path.join(tempDir, `${options.archiveRoot}.tar.gz`);
  await tar.c({ file: archivePath, gzip: true, cwd: tempDir }, [options.archiveRoot]);
  return archivePath;
}

async function createFakeOpenClaw(options: {
  homeDir: string;
  archiveQueuePath: string;
  statusModePath: string;
  restoreMarkerPath: string;
  commandLogPath: string;
  verifyArchiveRoot: string;
  notificationLogPath?: string;
  notificationModePath?: string;
  gatewayStartFailuresPath?: string;
}) {
  const scriptPath = path.join(options.homeDir, "fake-openclaw.mjs");
  await writeExecutableScript(
    scriptPath,
    `#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
const args = process.argv.slice(2);
const commandLogPath = ${JSON.stringify(options.commandLogPath)};
const appendLog = async (line) => {
  await fs.appendFile(commandLogPath, line + "\\n", "utf8");
};
if (args[0] === "backup" && args[1] === "create") {
  await appendLog("backup create");
  const queue = JSON.parse(await fs.readFile(${JSON.stringify(options.archiveQueuePath)}, "utf8"));
  const onlyConfig = args.includes("--only-config");
  const nextArchive = queue[0];
  if (!onlyConfig) {
    queue.shift();
    await fs.writeFile(${JSON.stringify(options.archiveQueuePath)}, JSON.stringify(queue), "utf8");
  }
  if (!nextArchive) {
    console.error("no queued archive available");
    process.exit(1);
  }
  const outputDir = args[args.indexOf("--output") + 1];
  await fs.mkdir(outputDir, { recursive: true });
  const target = path.join(outputDir, path.basename(nextArchive));
  await fs.copyFile(nextArchive, target);
  console.log(JSON.stringify({ archivePath: target, createdAt: "2026-03-09T00:00:00.000Z", onlyConfig }));
  process.exit(0);
}
if (args[0] === "backup" && args[1] === "verify") {
  await appendLog("backup verify");
  await fs.writeFile(${JSON.stringify(options.restoreMarkerPath)}, args[2], "utf8");
  console.log(JSON.stringify({
    ok: true,
    archivePath: args[2],
    archiveRoot: ${JSON.stringify(options.verifyArchiveRoot)},
    createdAt: "2026-03-09T00:00:00.000Z",
    runtimeVersion: "test-runtime",
    assetCount: 1,
    entryCount: 2,
  }));
  process.exit(0);
}
if (args[0] === "status" && args[1] === "--json") {
  await appendLog("status");
  const mode = (await fs.readFile(${JSON.stringify(options.statusModePath)}, "utf8")).trim();
  console.log(JSON.stringify({ gateway: { reachable: mode === "healthy", misconfigured: false } }));
  process.exit(0);
}
if (args[0] === "gateway" && args[1] === "call" && args[2] === "send") {
  await appendLog("gateway call send");
  const mode = ${options.notificationModePath ? `((await fs.readFile(${JSON.stringify(options.notificationModePath)}, "utf8")).trim() || "success")` : '"success"'};
  if (mode === "fail") {
    console.error("gateway send unavailable");
    process.exit(1);
  }
  const params = JSON.parse(args[args.indexOf("--params") + 1]);
  ${options.notificationLogPath ? `await fs.appendFile(${JSON.stringify(options.notificationLogPath)}, JSON.stringify(params) + "\\n", "utf8");` : ""}
  console.log(JSON.stringify({ ok: true }));
  process.exit(0);
}
if (args[0] === "gateway" && args[1] === "start") {
  await appendLog("gateway start");
  ${
    options.gatewayStartFailuresPath
      ? `const failuresRemaining = Number.parseInt((await fs.readFile(${JSON.stringify(options.gatewayStartFailuresPath)}, "utf8")).trim() || "0", 10);
  if (Number.isFinite(failuresRemaining) && failuresRemaining > 0) {
    await fs.writeFile(${JSON.stringify(options.gatewayStartFailuresPath)}, String(failuresRemaining - 1), "utf8");
    console.error("gateway start failed");
    process.exit(1);
  }`
      : ""
  }
  console.log("gateway started");
  process.exit(0);
}
if (args[0] === "gateway" && args[1] === "install") {
  await appendLog("gateway install");
  console.log("gateway installed");
  process.exit(0);
}
console.error("unexpected fake openclaw args: " + args.join(" "));
process.exit(1);
`,
  );
  return scriptPath;
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 7_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

async function readCommandLog(commandLogPath: string) {
  const raw = await fs.readFile(commandLogPath, "utf8").catch(() => "");
  return raw.split("\n").map((entry) => entry.trim()).filter(Boolean);
}

async function rewriteConfig(configPath: string, sequence: number) {
  await fs.writeFile(configPath, `${JSON.stringify({ sequence }, null, 2)}\n`, "utf8");
}

afterEach(async () => {
  await Promise.all(
    sessions.splice(0).map(async (session) => {
      await session.close().catch(() => undefined);
      await session.closed.catch(() => undefined);
    }),
  );
  await Promise.all(tempDirs.splice(0).map((entry) => fs.rm(entry, { recursive: true, force: true })));
});

describe("startBackupWatch", () => {
  it("keeps watch backup-only by default and does not dispatch shared recovery notifications", async () => {
    const homeDir = await makeTempDir("phoenix-watch-default-");
    const stateDir = path.join(homeDir, ".openclaw");
    const outputDir = path.join(homeDir, "archives");
    const configPath = path.join(stateDir, "openclaw.json");
    await fs.mkdir(stateDir, { recursive: true });
    await rewriteConfig(configPath, 0);
    const archiveRoot = "2026-03-09T00-00-00.000Z-openclaw-backup";
    const sourceStateDir = path.join("/tmp", "phoenix-watch-default-source");
    const archivePath = await buildArchiveFixture({
      archiveRoot,
      manifest: {
        schemaVersion: 1,
        archiveRoot,
        createdAt: "2026-03-09T00:00:00.000Z",
        paths: { stateDir: sourceStateDir },
        assets: [],
      },
      files: [],
    });
    const archiveQueuePath = path.join(homeDir, "archive-queue.json");
    const statusModePath = path.join(homeDir, "status-mode.txt");
    const restoreMarkerPath = path.join(homeDir, "restore-marker.txt");
    const commandLogPath = path.join(homeDir, "command-log.txt");
    const notificationLogPath = path.join(homeDir, "notification-log.jsonl");
    await fs.writeFile(archiveQueuePath, JSON.stringify([archivePath]), "utf8");
    await fs.writeFile(statusModePath, "healthy", "utf8");
    const openclawBin = await createFakeOpenClaw({
      homeDir,
      archiveQueuePath,
      statusModePath,
      restoreMarkerPath,
      commandLogPath,
      verifyArchiveRoot: archiveRoot,
      notificationLogPath,
    });
    const logs: string[] = [];
    const session = await startBackupWatch({
      configPath,
      debounceMs: 40,
      env: { ...process.env, HOME: homeDir, OPENCLAW_STATE_DIR: stateDir, VITEST: "true" },
      openclawBin,
      outputDir,
      retain: 1,
      notification: {
        enabled: true,
        policy: "all",
        target: {
          to: "room://operators",
        },
      },
      log: (message: string) => logs.push(message),
    });
    sessions.push(session);

    await new Promise((resolve) => setTimeout(resolve, 150));
    await rewriteConfig(configPath, 1);
    await waitFor(async () => (await readCommandLog(commandLogPath)).filter((entry) => entry === "backup create").length === 2);

    expect((await readCommandLog(commandLogPath)).filter((entry) => entry === "backup create")).toHaveLength(2);
    expect(await fileExists(path.join(outputDir, ".openclaw-phoenix-state.json"))).toBe(false);
    expect(await fileExists(path.join(outputDir, "config-only", `${archiveRoot}.tar.gz`))).toBe(true);
    expect(await fileExists(notificationLogPath)).toBe(false);
    expect(logs).toContain("watch mode: backup-only");
    await waitFor(async () => {
      const snapshot = await buildPhoenixWebSnapshot({
        configPath,
        env: { ...process.env, HOME: homeDir, OPENCLAW_STATE_DIR: stateDir },
        outputDir,
        timelineLimit: 5,
      });
      return snapshot.overview.latestAction !== undefined;
    });
    const snapshot = await buildPhoenixWebSnapshot({
      configPath,
      env: { ...process.env, HOME: homeDir, OPENCLAW_STATE_DIR: stateDir },
      outputDir,
      timelineLimit: 5,
    });
    expect(snapshot.overview.latestAction).toMatchObject({ origin: "watch", operation: "backup-cycle", status: "ok" });
    expect(snapshot.overview.latestHealth).toBeUndefined();
    expect(snapshot.config.origins.watch).toMatchObject({ selfHeal: false, retain: 1, notification: { policy: "off" } });
  }, 15_000);

  it("restarts gateway after a non-config watch cycle when the local gateway port is down", async () => {
    const homeDir = await makeTempDir("phoenix-watch-gateway-restart-");
    const stateDir = path.join(homeDir, ".openclaw");
    const outputDir = path.join(homeDir, "archives");
    const oauthDir = path.join(stateDir, "credentials");
    const configPath = path.join(stateDir, "openclaw.json");
    await fs.mkdir(oauthDir, { recursive: true });
    await rewriteConfig(configPath, 0);
    const archiveRoot = "2026-03-11T00-00-00.000Z-openclaw-backup";
    const sourceStateDir = path.join("/tmp", "phoenix-watch-gateway-restart-source");
    const archivePath = await buildArchiveFixture({
      archiveRoot,
      manifest: {
        schemaVersion: 1,
        archiveRoot,
        createdAt: "2026-03-11T00:00:00.000Z",
        paths: { stateDir: sourceStateDir },
        assets: [],
      },
      files: [],
    });
    const archiveQueuePath = path.join(homeDir, "archive-queue.json");
    const statusModePath = path.join(homeDir, "status-mode.txt");
    const restoreMarkerPath = path.join(homeDir, "restore-marker.txt");
    const commandLogPath = path.join(homeDir, "command-log.txt");
    const gatewayStartFailuresPath = path.join(homeDir, "gateway-start-failures.txt");
    await fs.writeFile(archiveQueuePath, JSON.stringify([archivePath]), "utf8");
    await fs.writeFile(statusModePath, "healthy", "utf8");
    await fs.writeFile(gatewayStartFailuresPath, "0", "utf8");
    const openclawBin = await createFakeOpenClaw({
      homeDir,
      archiveQueuePath,
      statusModePath,
      restoreMarkerPath,
      commandLogPath,
      verifyArchiveRoot: archiveRoot,
      gatewayStartFailuresPath,
    });

    const logs: string[] = [];
    const watchOptions = {
      configPath,
      debounceMs: 40,
      env: { ...process.env, HOME: homeDir, OPENCLAW_STATE_DIR: stateDir, VITEST: "true" },
      openclawBin,
      outputDir,
      retain: 1,
      log: (message: string) => logs.push(message),
      probeGatewayPort: async () => false,
    };
    const session = await startBackupWatch(watchOptions);
    sessions.push(session);

    await new Promise((resolve) => setTimeout(resolve, 150));
    await fs.writeFile(path.join(oauthDir, "session.json"), JSON.stringify({ updatedAt: Date.now() }), "utf8");
    await waitFor(async () => (await readCommandLog(commandLogPath)).includes("gateway start"));

    const commandLog = await readCommandLog(commandLogPath);
    expect(commandLog).toEqual(expect.arrayContaining(["backup create", "gateway start"]));
    expect(commandLog.filter((entry) => entry === "gateway start")).toHaveLength(1);
    expect(commandLog).not.toContain("gateway install");
    expect(logs).toContain("watch mode: backup-only");
  }, 15_000);

  it("dispatches all-policy healthy notifications when watch self-heal is enabled", async () => {
    const homeDir = await makeTempDir("phoenix-watch-heal-notify-");
    const stateDir = path.join(homeDir, ".openclaw");
    const outputDir = path.join(homeDir, "archives");
    const configPath = path.join(stateDir, "openclaw.json");
    await fs.mkdir(stateDir, { recursive: true });
    await rewriteConfig(configPath, 0);
    const archiveRoot = "2026-03-10T00-00-00.000Z-openclaw-backup";
    const sourceStateDir = path.join("/tmp", "phoenix-watch-heal-notify-source");
    const archivePath = await buildArchiveFixture({
      archiveRoot,
      manifest: {
        schemaVersion: 1,
        archiveRoot,
        createdAt: "2026-03-10T00:00:00.000Z",
        paths: { stateDir: sourceStateDir },
        assets: [],
      },
      files: [],
    });
    const archiveQueuePath = path.join(homeDir, "archive-queue.json");
    const statusModePath = path.join(homeDir, "status-mode.txt");
    const restoreMarkerPath = path.join(homeDir, "restore-marker.txt");
    const commandLogPath = path.join(homeDir, "command-log.txt");
    const notificationLogPath = path.join(homeDir, "notification-log.jsonl");
    await fs.writeFile(archiveQueuePath, JSON.stringify([archivePath]), "utf8");
    await fs.writeFile(statusModePath, "healthy", "utf8");
    const openclawBin = await createFakeOpenClaw({
      homeDir,
      archiveQueuePath,
      statusModePath,
      restoreMarkerPath,
      commandLogPath,
      verifyArchiveRoot: archiveRoot,
      notificationLogPath,
    });
    const logs: string[] = [];
    const session = await startBackupWatch({
      configPath,
      debounceMs: 40,
      env: { ...process.env, HOME: homeDir, OPENCLAW_STATE_DIR: stateDir, VITEST: "true" },
      openclawBin,
      outputDir,
      retain: 1,
      selfHeal: true,
      notification: {
        enabled: true,
        policy: "all",
        target: {
          to: "room://operators",
          channel: "slack",
          threadId: "watch-thread",
        },
      },
      log: (message: string) => logs.push(message),
    });
    sessions.push(session);

    await new Promise((resolve) => setTimeout(resolve, 150));
    await rewriteConfig(configPath, 1);
    await waitFor(async () => await fileExists(notificationLogPath));

    const commandLog = await readCommandLog(commandLogPath);
    expect(commandLog).toEqual(expect.arrayContaining(["backup create", "status", "gateway call send"]));
    expect(commandLog.filter((entry) => entry === "backup create")).toHaveLength(2);
    expect(await fileExists(path.join(outputDir, ".openclaw-phoenix-state.json"))).toBe(true);
    expect(logs).toContain("watch mode: self-heal");

    const payload = JSON.parse((await fs.readFile(notificationLogPath, "utf8")).trim());
    expect(payload).toMatchObject({
      to: "room://operators",
      channel: "slack",
      threadId: "watch-thread",
    });
    expect(payload.message).toContain("confirmed healthy status");
  }, 15_000);

  it("keeps watching after a notification delivery failure and succeeds on the next change", async () => {
    const homeDir = await makeTempDir("phoenix-watch-notify-retry-");
    const stateDir = path.join(homeDir, ".openclaw");
    const outputDir = path.join(homeDir, "archives");
    const configPath = path.join(stateDir, "openclaw.json");
    await fs.mkdir(stateDir, { recursive: true });
    await rewriteConfig(configPath, 0);
    const sourceStateDir = path.join("/tmp", "phoenix-watch-notify-retry-source");
    const firstArchive = await buildArchiveFixture({
      archiveRoot: "2026-03-10T03-00-00.000Z-openclaw-backup",
      manifest: {
        schemaVersion: 1,
        archiveRoot: "2026-03-10T03-00-00.000Z-openclaw-backup",
        createdAt: "2026-03-10T03:00:00.000Z",
        paths: { stateDir: sourceStateDir },
        assets: [],
      },
      files: [],
    });
    const secondArchive = await buildArchiveFixture({
      archiveRoot: "2026-03-10T04-00-00.000Z-openclaw-backup",
      manifest: {
        schemaVersion: 1,
        archiveRoot: "2026-03-10T04-00-00.000Z-openclaw-backup",
        createdAt: "2026-03-10T04:00:00.000Z",
        paths: { stateDir: sourceStateDir },
        assets: [],
      },
      files: [],
    });
    const archiveQueuePath = path.join(homeDir, "archive-queue.json");
    const statusModePath = path.join(homeDir, "status-mode.txt");
    const restoreMarkerPath = path.join(homeDir, "restore-marker.txt");
    const commandLogPath = path.join(homeDir, "command-log.txt");
    const notificationLogPath = path.join(homeDir, "notification-log.jsonl");
    const notificationModePath = path.join(homeDir, "notification-mode.txt");
    await fs.writeFile(archiveQueuePath, JSON.stringify([firstArchive, secondArchive]), "utf8");
    await fs.writeFile(statusModePath, "healthy", "utf8");
    await fs.writeFile(notificationModePath, "fail", "utf8");
    const openclawBin = await createFakeOpenClaw({
      homeDir,
      archiveQueuePath,
      statusModePath,
      restoreMarkerPath,
      commandLogPath,
      verifyArchiveRoot: "2026-03-10T03-00-00.000Z-openclaw-backup",
      notificationLogPath,
      notificationModePath,
    });
    const logs: string[] = [];
    const errors: string[] = [];
    const session = await startBackupWatch({
      configPath,
      debounceMs: 40,
      env: { ...process.env, HOME: homeDir, OPENCLAW_STATE_DIR: stateDir, VITEST: "true" },
      openclawBin,
      outputDir,
      retain: 2,
      selfHeal: true,
      notification: {
        enabled: true,
        policy: "all",
        target: {
          to: "room://operators",
        },
      },
      log: (message: string) => logs.push(message),
      error: (message) => errors.push(message),
    });
    sessions.push(session);

    await new Promise((resolve) => setTimeout(resolve, 150));
    await rewriteConfig(configPath, 1);
    await waitFor(async () => errors.some((entry) => entry.includes("notification delivery failed (healthy)")));

    await fs.writeFile(notificationModePath, "success", "utf8");
    await rewriteConfig(configPath, 2);
    await waitFor(async () => await fileExists(notificationLogPath));

    const commandLog = await readCommandLog(commandLogPath);
    expect(commandLog.filter((entry) => entry === "backup create")).toHaveLength(4);
    expect(commandLog.filter((entry) => entry === "status")).toHaveLength(2);
    expect(commandLog.filter((entry) => entry === "gateway call send")).toHaveLength(2);
    expect(errors.some((entry) => entry.includes("notification delivery failed (healthy)"))).toBe(true);
    expect(logs.some((entry) => entry.includes("latest-known-good updated"))).toBe(true);
    expect(JSON.parse((await fs.readFile(notificationLogPath, "utf8")).trim())).toMatchObject({ to: "room://operators" });
  }, 15_000);

  it("routes opt-in watch self-heal cycles through shared recovery and rolls back unhealthy snapshots", async () => {
    const homeDir = await makeTempDir("phoenix-watch-heal-");
    const stateDir = path.join(homeDir, ".openclaw");
    const outputDir = path.join(homeDir, "archives");
    const configPath = path.join(stateDir, "openclaw.json");
    const liveConfigPath = path.join(stateDir, "runtime-config.json");
    await fs.mkdir(stateDir, { recursive: true });
    await rewriteConfig(configPath, 0);
    await fs.writeFile(liveConfigPath, JSON.stringify({ version: "healthy" }), "utf8");
    const sourceStateDir = path.join("/tmp", "phoenix-watch-heal-source");
    const healthyArchiveRoot = "2026-03-09T00-00-00.000Z-openclaw-backup";
    const healthyArchive = await buildArchiveFixture({
      archiveRoot: healthyArchiveRoot,
      manifest: {
        schemaVersion: 1,
        archiveRoot: healthyArchiveRoot,
        createdAt: "2026-03-09T00:00:00.000Z",
        paths: {
          stateDir: sourceStateDir,
          configPath: path.join(sourceStateDir, "openclaw.json"),
          oauthDir: path.join(sourceStateDir, "credentials"),
        },
        assets: [
          {
            kind: "config",
            sourcePath: path.join(sourceStateDir, "runtime-config.json"),
            archivePath: path.posix.join(healthyArchiveRoot, "payload", "posix", sourceStateDir.slice(1), "runtime-config.json"),
          },
        ],
      },
      files: [
        {
          archivePath: path.posix.join(healthyArchiveRoot, "payload", "posix", sourceStateDir.slice(1), "runtime-config.json"),
          contents: JSON.stringify({ version: "healthy" }),
        },
      ],
    });
    const unhealthyArchiveRoot = "2026-03-09T01-00-00.000Z-openclaw-backup";
    const unhealthyArchive = await buildArchiveFixture({
      archiveRoot: unhealthyArchiveRoot,
      manifest: {
        schemaVersion: 1,
        archiveRoot: unhealthyArchiveRoot,
        createdAt: "2026-03-09T01:00:00.000Z",
        paths: {
          stateDir: sourceStateDir,
          configPath: path.join(sourceStateDir, "openclaw.json"),
          oauthDir: path.join(sourceStateDir, "credentials"),
        },
        assets: [
          {
            kind: "config",
            sourcePath: path.join(sourceStateDir, "runtime-config.json"),
            archivePath: path.posix.join(unhealthyArchiveRoot, "payload", "posix", sourceStateDir.slice(1), "runtime-config.json"),
          },
        ],
      },
      files: [
        {
          archivePath: path.posix.join(unhealthyArchiveRoot, "payload", "posix", sourceStateDir.slice(1), "runtime-config.json"),
          contents: JSON.stringify({ version: "broken-snapshot" }),
        },
      ],
    });
    const archiveQueuePath = path.join(homeDir, "archive-queue.json");
    const statusModePath = path.join(homeDir, "status-mode.txt");
    const restoreMarkerPath = path.join(homeDir, "restore-marker.txt");
    const commandLogPath = path.join(homeDir, "command-log.txt");
    const gatewayStartFailuresPath = path.join(homeDir, "gateway-start-failures.txt");
    await fs.writeFile(archiveQueuePath, JSON.stringify([healthyArchive, unhealthyArchive]), "utf8");
    await fs.writeFile(statusModePath, "healthy", "utf8");
    await fs.writeFile(gatewayStartFailuresPath, "1", "utf8");
    const openclawBin = await createFakeOpenClaw({
      homeDir,
      archiveQueuePath,
      statusModePath,
      restoreMarkerPath,
      commandLogPath,
      verifyArchiveRoot: healthyArchiveRoot,
      gatewayStartFailuresPath,
    });
    const logs: string[] = [];
    const watchOptions = {
      configPath,
      debounceMs: 40,
      env: { ...process.env, HOME: homeDir, OPENCLAW_STATE_DIR: stateDir, VITEST: "true" },
      openclawBin,
      outputDir,
      retain: 1,
      selfHeal: true,
      log: (message: string) => logs.push(message),
      probeGatewayPort: async () => false,
    };
    const session = await startBackupWatch(watchOptions);
    sessions.push(session);

    await new Promise((resolve) => setTimeout(resolve, 150));
    await rewriteConfig(configPath, 1);
    await waitFor(async () => {
      const raw = await fs.readFile(path.join(outputDir, ".openclaw-phoenix-state.json"), "utf8").catch(() => "");
      return raw.includes(`${healthyArchiveRoot}.tar.gz`);
    });

    await fs.writeFile(liveConfigPath, JSON.stringify({ version: "bad" }), "utf8");
    await fs.writeFile(statusModePath, "unhealthy", "utf8");
    await rewriteConfig(configPath, 2);
    await waitFor(async () => {
      const liveConfig = await fs.readFile(liveConfigPath, "utf8").catch(() => "");
      const commandLog = await readCommandLog(commandLogPath);
      return (
        liveConfig.includes('"healthy"') &&
        (await fileExists(restoreMarkerPath)) &&
        commandLog.filter((entry) => entry === "gateway start").length >= 2 &&
        commandLog.includes("gateway install") &&
        logs.some((entry) => entry.includes("rolled back"))
      );
    });

    expect(JSON.parse(await fs.readFile(liveConfigPath, "utf8"))).toEqual({ version: "healthy" });
    expect(await fs.readFile(restoreMarkerPath, "utf8")).toContain(`${healthyArchiveRoot}.tar.gz`);
    const commandLog = await readCommandLog(commandLogPath);
    expect(commandLog).toEqual(expect.arrayContaining([
      "backup create",
      "status",
      "backup verify",
      "gateway start",
      "gateway install",
    ]));
    expect(commandLog.filter((entry) => entry === "gateway start")).toHaveLength(2);
    expect(commandLog.filter((entry) => entry === "gateway install")).toHaveLength(1);
    expect(logs.some((entry) => entry.includes("rolled back"))).toBe(true);
    expect(logs).toContain("watch mode: self-heal");
  }, 15_000);

  it("keeps running after a failed self-heal cycle and can recover on the next change", async () => {
    const homeDir = await makeTempDir("phoenix-watch-survive-");
    const stateDir = path.join(homeDir, ".openclaw");
    const outputDir = path.join(homeDir, "archives");
    const configPath = path.join(stateDir, "openclaw.json");
    await fs.mkdir(stateDir, { recursive: true });
    await rewriteConfig(configPath, 0);
    const sourceStateDir = path.join("/tmp", "phoenix-watch-survive-source");
    const firstArchiveRoot = "2026-03-09T00-00-00.000Z-openclaw-backup";
    const firstArchive = await buildArchiveFixture({
      archiveRoot: firstArchiveRoot,
      manifest: {
        schemaVersion: 1,
        archiveRoot: firstArchiveRoot,
        createdAt: "2026-03-09T00:00:00.000Z",
        paths: { stateDir: sourceStateDir },
        assets: [],
      },
      files: [],
    });
    const secondArchiveRoot = "2026-03-09T01-00-00.000Z-openclaw-backup";
    const secondArchive = await buildArchiveFixture({
      archiveRoot: secondArchiveRoot,
      manifest: {
        schemaVersion: 1,
        archiveRoot: secondArchiveRoot,
        createdAt: "2026-03-09T01:00:00.000Z",
        paths: { stateDir: sourceStateDir },
        assets: [],
      },
      files: [],
    });
    const archiveQueuePath = path.join(homeDir, "archive-queue.json");
    const statusModePath = path.join(homeDir, "status-mode.txt");
    const restoreMarkerPath = path.join(homeDir, "restore-marker.txt");
    const commandLogPath = path.join(homeDir, "command-log.txt");
    await fs.writeFile(archiveQueuePath, JSON.stringify([firstArchive, secondArchive]), "utf8");
    await fs.writeFile(statusModePath, "unhealthy", "utf8");
    const openclawBin = await createFakeOpenClaw({
      homeDir,
      archiveQueuePath,
      statusModePath,
      restoreMarkerPath,
      commandLogPath,
      verifyArchiveRoot: firstArchiveRoot,
    });
    const logs: string[] = [];
    const session = await startBackupWatch({
      configPath,
      debounceMs: 40,
      env: { ...process.env, HOME: homeDir, OPENCLAW_STATE_DIR: stateDir, VITEST: "true" },
      openclawBin,
      outputDir,
      retain: 2,
      selfHeal: true,
      log: (message: string) => logs.push(message),
    });
    sessions.push(session);

    await new Promise((resolve) => setTimeout(resolve, 150));
    await rewriteConfig(configPath, 1);
    await waitFor(async () => logs.some((entry) => entry.includes("has no known-good archive to restore")));

    await fs.writeFile(statusModePath, "healthy", "utf8");
    await rewriteConfig(configPath, 2);
    await waitFor(async () => {
      const raw = await fs.readFile(path.join(outputDir, ".openclaw-phoenix-state.json"), "utf8").catch(() => "");
      return raw.includes(`${secondArchiveRoot}.tar.gz`) && logs.some((entry) => entry.includes("latest-known-good updated"));
    });

    const commandLog = await readCommandLog(commandLogPath);
    expect(commandLog.filter((entry) => entry === "backup create")).toHaveLength(4);
    expect(commandLog.filter((entry) => entry === "status")).toHaveLength(2);
    expect(logs.some((entry) => entry.includes("latest-known-good updated"))).toBe(true);
  }, 15_000);
});
