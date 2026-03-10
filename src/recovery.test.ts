import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { afterEach, describe, expect, it } from "vitest";
import { buildBackupArchivePath } from "./paths.js";
import { runPhoenixRecovery } from "./recovery.js";

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
  verifyArchiveRoot: string;
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
    const persistedState = JSON.parse(await fs.readFile(path.join(outputDir, ".openclaw-phoenix-state.json"), "utf8"));
    expect(persistedState.latestKnownGoodArchivePath).toBe(result.backup.archivePath);
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
  });
});