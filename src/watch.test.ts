import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { afterEach, describe, expect, it } from "vitest";
import type { BackupWatchSession } from "./watch.js";
import { startBackupWatch } from "./watch.js";

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
  const nextArchive = queue.shift();
  await fs.writeFile(${JSON.stringify(options.archiveQueuePath)}, JSON.stringify(queue), "utf8");
  if (!nextArchive) {
    console.error("no queued archive available");
    process.exit(1);
  }
  const outputDir = args[args.indexOf("--output") + 1];
  await fs.mkdir(outputDir, { recursive: true });
  const target = path.join(outputDir, path.basename(nextArchive));
  await fs.copyFile(nextArchive, target);
  console.log(JSON.stringify({ archivePath: target, createdAt: "2026-03-09T00:00:00.000Z" }));
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
  it("keeps watch backup-only by default", async () => {
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
    await fs.writeFile(archiveQueuePath, JSON.stringify([archivePath]), "utf8");
    await fs.writeFile(statusModePath, "healthy", "utf8");
    const openclawBin = await createFakeOpenClaw({
      homeDir,
      archiveQueuePath,
      statusModePath,
      restoreMarkerPath,
      commandLogPath,
      verifyArchiveRoot: archiveRoot,
    });
    const logs: string[] = [];
    const session = await startBackupWatch({
      configPath,
      debounceMs: 40,
      env: { ...process.env, HOME: homeDir, OPENCLAW_STATE_DIR: stateDir, VITEST: "true" },
      openclawBin,
      outputDir,
      retain: 1,
      log: (message) => logs.push(message),
    });
    sessions.push(session);

    await new Promise((resolve) => setTimeout(resolve, 150));
    await rewriteConfig(configPath, 1);
    await waitFor(async () => (await readCommandLog(commandLogPath)).includes("backup create"));

    expect(await readCommandLog(commandLogPath)).toEqual(["backup create"]);
    expect(await fileExists(path.join(outputDir, ".openclaw-phoenix-state.json"))).toBe(false);
    expect(logs).toContain("watch mode: backup-only");
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
    await fs.writeFile(archiveQueuePath, JSON.stringify([healthyArchive, unhealthyArchive]), "utf8");
    await fs.writeFile(statusModePath, "healthy", "utf8");
    const openclawBin = await createFakeOpenClaw({
      homeDir,
      archiveQueuePath,
      statusModePath,
      restoreMarkerPath,
      commandLogPath,
      verifyArchiveRoot: healthyArchiveRoot,
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
      log: (message) => logs.push(message),
    });
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
      return (
        liveConfig.includes('"healthy"') &&
        (await fileExists(restoreMarkerPath)) &&
        logs.some((entry) => entry.includes("rolled back"))
      );
    });

    expect(JSON.parse(await fs.readFile(liveConfigPath, "utf8"))).toEqual({ version: "healthy" });
    expect(await fs.readFile(restoreMarkerPath, "utf8")).toContain(`${healthyArchiveRoot}.tar.gz`);
    expect(await readCommandLog(commandLogPath)).toEqual(
      expect.arrayContaining(["backup create", "status", "backup verify"]),
    );
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
      log: (message) => logs.push(message),
    });
    sessions.push(session);

    await new Promise((resolve) => setTimeout(resolve, 150));
    await rewriteConfig(configPath, 1);
    await waitFor(async () => logs.some((entry) => entry.includes("has no known-good archive to restore")));

    await fs.writeFile(statusModePath, "healthy", "utf8");
    await rewriteConfig(configPath, 2);
    await waitFor(async () => {
      const raw = await fs.readFile(path.join(outputDir, ".openclaw-phoenix-state.json"), "utf8").catch(() => "");
      return raw.includes(`${secondArchiveRoot}.tar.gz`);
    });

    const commandLog = await readCommandLog(commandLogPath);
    expect(commandLog.filter((entry) => entry === "backup create")).toHaveLength(2);
    expect(commandLog.filter((entry) => entry === "status")).toHaveLength(2);
    expect(logs.some((entry) => entry.includes("latest-known-good updated"))).toBe(true);
  }, 15_000);
});