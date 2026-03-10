import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { afterEach, describe, expect, it } from "vitest";
import { buildBackupArchivePath } from "./paths.js";
import { runPhoenixRecovery } from "./recovery.js";
import { buildPhoenixWebSnapshot } from "./web-contract.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function writeExecutableScript(scriptPath: string, body: string) {
  await fs.writeFile(scriptPath, body, { encoding: "utf8", mode: 0o755 });
}

async function buildArchiveFixture(options: {
  archiveRoot: string;
  manifest: Record<string, unknown>;
  files: Array<{ archivePath: string; contents: string }>;
}) {
  const tempDir = await makeTempDir("phoenix-recovery-archive-");
  const rootDir = path.join(tempDir, options.archiveRoot);
  await fs.mkdir(rootDir, { recursive: true });
  await fs.writeFile(path.join(rootDir, "manifest.json"), `${JSON.stringify(options.manifest, null, 2)}
`, "utf8");
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
  verifyArchiveRoot: string;
  notificationLogPath?: string;
  notificationModePath?: string;
}) {
  const scriptPath = path.join(options.homeDir, "fake-openclaw.mjs");
  await writeExecutableScript(
    scriptPath,
    `#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
const args = process.argv.slice(2);
if (args[0] === "backup" && args[1] === "create") {
  const queue = JSON.parse(await fs.readFile(${JSON.stringify(options.archiveQueuePath)}, "utf8"));
  const nextArchive = queue.shift();
  await fs.writeFile(${JSON.stringify(options.archiveQueuePath)}, JSON.stringify(queue), "utf8");
  const outputDir = args[args.indexOf("--output") + 1];
  await fs.mkdir(outputDir, { recursive: true });
  const target = path.join(outputDir, path.basename(nextArchive));
  await fs.copyFile(nextArchive, target);
  console.log(JSON.stringify({ archivePath: target, createdAt: "2026-03-09T00:00:00.000Z" }));
  process.exit(0);
}
if (args[0] === "backup" && args[1] === "verify") {
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
  const mode = (await fs.readFile(${JSON.stringify(options.statusModePath)}, "utf8")).trim();
  console.log(JSON.stringify({ gateway: { reachable: mode === "healthy", misconfigured: false } }));
  process.exit(0);
}
if (args[0] === "gateway" && args[1] === "call" && args[2] === "send") {
  const mode = ${options.notificationModePath ? `((await fs.readFile(${JSON.stringify(options.notificationModePath)}, "utf8")).trim() || "success")` : '"success"'};
  if (mode === "fail") {
    console.error("gateway send unavailable");
    process.exit(1);
  }
  const params = JSON.parse(args[args.indexOf("--params") + 1]);
  ${options.notificationLogPath ? `await fs.appendFile(${JSON.stringify(options.notificationLogPath)}, JSON.stringify(params) + "\\n", "utf8");` : ''}
  console.log(JSON.stringify({ ok: true }));
  process.exit(0);
}
console.error("unexpected fake openclaw args: " + args.join(" "));
process.exit(1);
`,
  );
  return scriptPath;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((entry) => fs.rm(entry, { recursive: true, force: true })));
});

describe("runPhoenixRecovery", () => {
  it("promotes a healthy backup to known-good and records shared recovery state", async () => {
    const homeDir = await makeTempDir("phoenix-recovery-home-");
    const outputDir = path.join(homeDir, "archives");
    const archiveRoot = "2026-03-09T00-00-00.000Z-openclaw-backup";
    const sourceStateDir = path.join("/tmp", "phoenix-recovery-source-state");
    const healthyArchive = await buildArchiveFixture({
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
    await fs.writeFile(archiveQueuePath, JSON.stringify([healthyArchive]), "utf8");
    await fs.writeFile(statusModePath, "healthy", "utf8");
    const openclawBin = await createFakeOpenClaw({
      homeDir,
      archiveQueuePath,
      statusModePath,
      restoreMarkerPath,
      verifyArchiveRoot: archiveRoot,
    });

    const result = await runPhoenixRecovery({
      openclawBin,
      outputDir,
      retain: 1,
      env: { ...process.env, HOME: homeDir },
    });

    expect(result.ok).toBe(true);
    expect(result.health).toEqual({ healthy: true, reason: "gateway reachable" });
    expect(result.backup.archivePath).toContain(`${archiveRoot}.tar.gz`);
    expect(result.knownGood.currentArchivePath).toBe(result.backup.archivePath);
    expect(result.knownGood.promotedArchivePath).toBe(result.backup.archivePath);
    expect(result.notifications).toEqual([]);
    expect(result.notificationDelivery.results).toEqual([]);
    const persistedState = JSON.parse(await fs.readFile(path.join(outputDir, ".openclaw-phoenix-state.json"), "utf8"));
    expect(persistedState.latestKnownGoodArchivePath).toBe(result.backup.archivePath);
    const snapshot = await buildPhoenixWebSnapshot({
      env: { ...process.env, HOME: homeDir },
      outputDir,
      timelineLimit: 5,
    });
    expect(snapshot.overview.latestAction).toMatchObject({ origin: "manual", operation: "recovery-cycle", status: "ok" });
    expect(snapshot.overview.latestHealth?.result).toEqual({ attempted: true, healthy: true, reason: "gateway reachable" });
    expect(snapshot.config.origins.manual).toMatchObject({ outputDir, retain: 1, notification: { policy: "off" } });
    expect(snapshot.archives.archives[0]).toMatchObject({
      archivePath: result.backup.archivePath,
      roles: expect.arrayContaining(["latest-known-good", "last-backup"]),
    });
  });

  it("rolls back to the previous known-good archive and protects it during retention", async () => {
    const homeDir = await makeTempDir("phoenix-recovery-rollback-");
    const outputDir = path.join(homeDir, "archives");
    const currentStateDir = path.join(homeDir, ".openclaw");
    const liveConfigPath = path.join(currentStateDir, "runtime-config.json");
    await fs.mkdir(currentStateDir, { recursive: true });
    await fs.writeFile(liveConfigPath, JSON.stringify({ version: "healthy" }), "utf8");
    const sourceStateDir = path.join("/tmp", "phoenix-recovery-rollback-source");
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
            archivePath: buildBackupArchivePath(healthyArchiveRoot, path.join(sourceStateDir, "runtime-config.json")),
          },
        ],
      },
      files: [
        {
          archivePath: buildBackupArchivePath(healthyArchiveRoot, path.join(sourceStateDir, "runtime-config.json")),
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
            archivePath: buildBackupArchivePath(unhealthyArchiveRoot, path.join(sourceStateDir, "runtime-config.json")),
          },
        ],
      },
      files: [
        {
          archivePath: buildBackupArchivePath(unhealthyArchiveRoot, path.join(sourceStateDir, "runtime-config.json")),
          contents: JSON.stringify({ version: "broken-snapshot" }),
        },
      ],
    });
    const archiveQueuePath = path.join(homeDir, "archive-queue.json");
    const statusModePath = path.join(homeDir, "status-mode.txt");
    const restoreMarkerPath = path.join(homeDir, "restore-marker.txt");
    await fs.writeFile(archiveQueuePath, JSON.stringify([healthyArchive, unhealthyArchive]), "utf8");
    await fs.writeFile(statusModePath, "healthy", "utf8");
    const openclawBin = await createFakeOpenClaw({
      homeDir,
      archiveQueuePath,
      statusModePath,
      restoreMarkerPath,
      verifyArchiveRoot: healthyArchiveRoot,
    });

    const first = await runPhoenixRecovery({
      openclawBin,
      outputDir,
      retain: 1,
      env: { ...process.env, HOME: homeDir, OPENCLAW_STATE_DIR: currentStateDir },
    });
    await fs.writeFile(liveConfigPath, JSON.stringify({ version: "bad" }), "utf8");
    await fs.writeFile(statusModePath, "unhealthy", "utf8");

    const second = await runPhoenixRecovery({
      openclawBin,
      outputDir,
      retain: 1,
      env: { ...process.env, HOME: homeDir, OPENCLAW_STATE_DIR: currentStateDir },
    });

    expect(first.knownGood.currentArchivePath).toContain(`${healthyArchiveRoot}.tar.gz`);
    expect(second.ok).toBe(true);
    expect(second.health.healthy).toBe(false);
    expect(second.rollback.restored).toBe(true);
    expect(second.knownGood.currentArchivePath).toBe(first.knownGood.currentArchivePath);
    expect(second.notifications[0]).toMatchObject({ code: "rollback-restored", severity: "warning" });
    expect(second.notifications[0]?.message).toContain("rolled back");
    expect(JSON.parse(await fs.readFile(liveConfigPath, "utf8"))).toEqual({ version: "healthy" });
    expect(await fs.readFile(restoreMarkerPath, "utf8")).toContain(`${healthyArchiveRoot}.tar.gz`);
    expect(second.retention.kept).toHaveLength(2);
    expect(second.retention.kept).toEqual(
      expect.arrayContaining([
        first.knownGood.currentArchivePath as string,
        second.backup.archivePath as string,
      ]),
    );
    expect(second.retention.deleted).toEqual([]);
    expect(second.notificationDelivery.results).toEqual([
      {
        attempted: false,
        delivered: false,
        event: second.notifications[0],
      },
    ]);
  });

  it("dispatches all-policy healthy notifications through openclaw gateway send", async () => {
    const homeDir = await makeTempDir("phoenix-recovery-notify-healthy-");
    const outputDir = path.join(homeDir, "archives");
    const archiveRoot = "2026-03-10T00-00-00.000Z-openclaw-backup";
    const sourceStateDir = path.join("/tmp", "phoenix-recovery-notify-healthy-state");
    const healthyArchive = await buildArchiveFixture({
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
    const notificationLogPath = path.join(homeDir, "notification-log.jsonl");
    await fs.writeFile(archiveQueuePath, JSON.stringify([healthyArchive]), "utf8");
    await fs.writeFile(statusModePath, "healthy", "utf8");
    const openclawBin = await createFakeOpenClaw({
      homeDir,
      archiveQueuePath,
      statusModePath,
      restoreMarkerPath,
      verifyArchiveRoot: archiveRoot,
      notificationLogPath,
    });

    const result = await runPhoenixRecovery({
      openclawBin,
      outputDir,
      retain: 1,
      env: { ...process.env, HOME: homeDir },
      notification: {
        enabled: true,
        policy: "all",
        target: {
          to: "room://operators",
          channel: "slack",
          threadId: "incident-thread",
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(result.notifications).toEqual([]);
    expect(result.notificationDelivery.results).toHaveLength(1);
    expect(result.notificationDelivery.results[0]).toMatchObject({
      attempted: true,
      delivered: true,
      event: { code: "healthy", severity: "info" },
    });
    const payload = JSON.parse((await fs.readFile(notificationLogPath, "utf8")).trim());
    expect(payload).toMatchObject({
      to: "room://operators",
      channel: "slack",
      threadId: "incident-thread",
    });
    expect(payload.message).toContain("confirmed healthy status");
  });

  it("keeps rollback success primary when gateway notification delivery fails", async () => {
    const homeDir = await makeTempDir("phoenix-recovery-notify-fail-");
    const outputDir = path.join(homeDir, "archives");
    const currentStateDir = path.join(homeDir, ".openclaw");
    const liveConfigPath = path.join(currentStateDir, "runtime-config.json");
    await fs.mkdir(currentStateDir, { recursive: true });
    await fs.writeFile(liveConfigPath, JSON.stringify({ version: "healthy" }), "utf8");
    const sourceStateDir = path.join("/tmp", "phoenix-recovery-notify-fail-source");
    const healthyArchiveRoot = "2026-03-10T00-00-00.000Z-openclaw-backup";
    const healthyArchive = await buildArchiveFixture({
      archiveRoot: healthyArchiveRoot,
      manifest: {
        schemaVersion: 1,
        archiveRoot: healthyArchiveRoot,
        createdAt: "2026-03-10T00:00:00.000Z",
        paths: {
          stateDir: sourceStateDir,
          configPath: path.join(sourceStateDir, "openclaw.json"),
          oauthDir: path.join(sourceStateDir, "credentials"),
        },
        assets: [
          {
            kind: "config",
            sourcePath: path.join(sourceStateDir, "runtime-config.json"),
            archivePath: buildBackupArchivePath(healthyArchiveRoot, path.join(sourceStateDir, "runtime-config.json")),
          },
        ],
      },
      files: [
        {
          archivePath: buildBackupArchivePath(healthyArchiveRoot, path.join(sourceStateDir, "runtime-config.json")),
          contents: JSON.stringify({ version: "healthy" }),
        },
      ],
    });
    const unhealthyArchiveRoot = "2026-03-10T01-00-00.000Z-openclaw-backup";
    const unhealthyArchive = await buildArchiveFixture({
      archiveRoot: unhealthyArchiveRoot,
      manifest: {
        schemaVersion: 1,
        archiveRoot: unhealthyArchiveRoot,
        createdAt: "2026-03-10T01:00:00.000Z",
        paths: {
          stateDir: sourceStateDir,
          configPath: path.join(sourceStateDir, "openclaw.json"),
          oauthDir: path.join(sourceStateDir, "credentials"),
        },
        assets: [
          {
            kind: "config",
            sourcePath: path.join(sourceStateDir, "runtime-config.json"),
            archivePath: buildBackupArchivePath(unhealthyArchiveRoot, path.join(sourceStateDir, "runtime-config.json")),
          },
        ],
      },
      files: [
        {
          archivePath: buildBackupArchivePath(unhealthyArchiveRoot, path.join(sourceStateDir, "runtime-config.json")),
          contents: JSON.stringify({ version: "broken-snapshot" }),
        },
      ],
    });
    const archiveQueuePath = path.join(homeDir, "archive-queue.json");
    const statusModePath = path.join(homeDir, "status-mode.txt");
    const restoreMarkerPath = path.join(homeDir, "restore-marker.txt");
    const notificationModePath = path.join(homeDir, "notification-mode.txt");
    await fs.writeFile(archiveQueuePath, JSON.stringify([healthyArchive, unhealthyArchive]), "utf8");
    await fs.writeFile(statusModePath, "healthy", "utf8");
    await fs.writeFile(notificationModePath, "success", "utf8");
    const openclawBin = await createFakeOpenClaw({
      homeDir,
      archiveQueuePath,
      statusModePath,
      restoreMarkerPath,
      verifyArchiveRoot: healthyArchiveRoot,
      notificationModePath,
    });

    await runPhoenixRecovery({
      openclawBin,
      outputDir,
      retain: 1,
      env: { ...process.env, HOME: homeDir, OPENCLAW_STATE_DIR: currentStateDir },
    });
    await fs.writeFile(liveConfigPath, JSON.stringify({ version: "bad" }), "utf8");
    await fs.writeFile(statusModePath, "unhealthy", "utf8");
    await fs.writeFile(notificationModePath, "fail", "utf8");

    const result = await runPhoenixRecovery({
      openclawBin,
      outputDir,
      retain: 1,
      env: { ...process.env, HOME: homeDir, OPENCLAW_STATE_DIR: currentStateDir },
      notification: {
        enabled: true,
        policy: "exceptional-only",
        target: {
          to: "room://operators",
          channel: "signal",
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(result.rollback.restored).toBe(true);
    expect(result.notificationDelivery.results).toHaveLength(1);
    expect(result.notificationDelivery.results[0]).toMatchObject({
      attempted: true,
      delivered: false,
      event: { code: "rollback-restored" },
    });
    expect(result.notificationDelivery.results[0]?.error).toContain("openclaw gateway call send");
    expect(result.notifications[0]?.message).toContain("rolled back");
    expect(JSON.parse(await fs.readFile(liveConfigPath, "utf8"))).toEqual({ version: "healthy" });
  });

  it("reports an unhealthy run with no known-good archive to restore", async () => {
    const homeDir = await makeTempDir("phoenix-recovery-missing-known-good-");
    const outputDir = path.join(homeDir, "archives");
    const archiveRoot = "2026-03-10T02-00-00.000Z-openclaw-backup";
    const sourceStateDir = path.join("/tmp", "phoenix-recovery-missing-known-good-state");
    const unhealthyArchive = await buildArchiveFixture({
      archiveRoot,
      manifest: {
        schemaVersion: 1,
        archiveRoot,
        createdAt: "2026-03-10T02:00:00.000Z",
        paths: { stateDir: sourceStateDir },
        assets: [],
      },
      files: [],
    });
    const archiveQueuePath = path.join(homeDir, "archive-queue.json");
    const statusModePath = path.join(homeDir, "status-mode.txt");
    const restoreMarkerPath = path.join(homeDir, "restore-marker.txt");
    await fs.writeFile(archiveQueuePath, JSON.stringify([unhealthyArchive]), "utf8");
    await fs.writeFile(statusModePath, "unhealthy", "utf8");
    const openclawBin = await createFakeOpenClaw({
      homeDir,
      archiveQueuePath,
      statusModePath,
      restoreMarkerPath,
      verifyArchiveRoot: archiveRoot,
    });

    const result = await runPhoenixRecovery({
      openclawBin,
      outputDir,
      retain: 1,
      env: { ...process.env, HOME: homeDir },
    });

    expect(result.ok).toBe(false);
    expect(result.rollback).toMatchObject({ needed: true, attempted: false, restored: false });
    expect(result.notifications).toEqual([
      expect.objectContaining({ code: "rollback-missing-known-good", severity: "warning" }),
    ]);
    expect(result.knownGood.currentArchivePath).toBeUndefined();
    expect(result.state.latestKnownGoodArchivePath).toBeUndefined();
    expect(result.state.lastBackupArchivePath).toBe(result.backup.archivePath);
    await expect(fs.stat(restoreMarkerPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports rollback failure when the known-good archive can no longer be restored", async () => {
    const homeDir = await makeTempDir("phoenix-recovery-rollback-failed-");
    const outputDir = path.join(homeDir, "archives");
    const currentStateDir = path.join(homeDir, ".openclaw");
    const liveConfigPath = path.join(currentStateDir, "runtime-config.json");
    await fs.mkdir(currentStateDir, { recursive: true });
    await fs.writeFile(liveConfigPath, JSON.stringify({ version: "healthy" }), "utf8");
    const sourceStateDir = path.join("/tmp", "phoenix-recovery-rollback-failed-state");
    const healthyArchiveRoot = "2026-03-10T03-00-00.000Z-openclaw-backup";
    const healthyArchive = await buildArchiveFixture({
      archiveRoot: healthyArchiveRoot,
      manifest: {
        schemaVersion: 1,
        archiveRoot: healthyArchiveRoot,
        createdAt: "2026-03-10T03:00:00.000Z",
        paths: {
          stateDir: sourceStateDir,
          configPath: path.join(sourceStateDir, "openclaw.json"),
          oauthDir: path.join(sourceStateDir, "credentials"),
        },
        assets: [
          {
            kind: "config",
            sourcePath: path.join(sourceStateDir, "runtime-config.json"),
            archivePath: buildBackupArchivePath(healthyArchiveRoot, path.join(sourceStateDir, "runtime-config.json")),
          },
        ],
      },
      files: [
        {
          archivePath: buildBackupArchivePath(healthyArchiveRoot, path.join(sourceStateDir, "runtime-config.json")),
          contents: JSON.stringify({ version: "healthy" }),
        },
      ],
    });
    const unhealthyArchiveRoot = "2026-03-10T04-00-00.000Z-openclaw-backup";
    const unhealthyArchive = await buildArchiveFixture({
      archiveRoot: unhealthyArchiveRoot,
      manifest: {
        schemaVersion: 1,
        archiveRoot: unhealthyArchiveRoot,
        createdAt: "2026-03-10T04:00:00.000Z",
        paths: { stateDir: sourceStateDir },
        assets: [],
      },
      files: [],
    });
    const archiveQueuePath = path.join(homeDir, "archive-queue.json");
    const statusModePath = path.join(homeDir, "status-mode.txt");
    const restoreMarkerPath = path.join(homeDir, "restore-marker.txt");
    await fs.writeFile(archiveQueuePath, JSON.stringify([healthyArchive, unhealthyArchive]), "utf8");
    await fs.writeFile(statusModePath, "healthy", "utf8");
    const openclawBin = await createFakeOpenClaw({
      homeDir,
      archiveQueuePath,
      statusModePath,
      restoreMarkerPath,
      verifyArchiveRoot: healthyArchiveRoot,
    });

    const first = await runPhoenixRecovery({
      openclawBin,
      outputDir,
      retain: 2,
      env: { ...process.env, HOME: homeDir, OPENCLAW_STATE_DIR: currentStateDir },
    });
    await fs.rm(first.knownGood.currentArchivePath as string, { force: true });
    await fs.writeFile(liveConfigPath, JSON.stringify({ version: "bad" }), "utf8");
    await fs.writeFile(statusModePath, "unhealthy", "utf8");

    const result = await runPhoenixRecovery({
      openclawBin,
      outputDir,
      retain: 2,
      env: { ...process.env, HOME: homeDir, OPENCLAW_STATE_DIR: currentStateDir },
    });

    expect(result.ok).toBe(false);
    expect(result.rollback).toMatchObject({ attempted: true, restored: false, archivePath: first.knownGood.currentArchivePath });
    expect(result.rollback.error).toMatch(/ENOENT|no such file/i);
    expect(result.notifications).toEqual([
      expect.objectContaining({ code: "rollback-failed", severity: "error" }),
    ]);
    expect(JSON.parse(await fs.readFile(liveConfigPath, "utf8"))).toEqual({ version: "bad" });
  });
});
