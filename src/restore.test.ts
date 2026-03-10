import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { afterEach, describe, expect, it } from "vitest";
import { buildBackupArchivePath } from "./paths.js";
import { restoreBackupArchive } from "./restore.js";
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

async function createFakeOpenClaw(tempDir: string, markerPath: string, archiveRoot: string, assetCount: number) {
  const scriptPath = path.join(tempDir, "fake-openclaw.mjs");
  await writeExecutableScript(
    scriptPath,
    `#!/usr/bin/env node
import fs from "node:fs/promises";
const args = process.argv.slice(2);
if (args[0] !== "backup" || args[1] !== "verify" || args[3] !== "--json") {
  console.error('unexpected args: ' + args.join(' '));
  process.exit(1);
}
await fs.writeFile(${JSON.stringify(markerPath)}, args[2], "utf8");
console.log(JSON.stringify({
  ok: true,
  archivePath: args[2],
  archiveRoot: ${JSON.stringify(archiveRoot)},
  createdAt: "2026-03-09T00:00:00.000Z",
  runtimeVersion: "test-runtime",
  assetCount: ${assetCount},
  entryCount: 3,
}));
`,
  );
  return scriptPath;
}

async function buildArchiveFixture(options: {
  archiveRoot: string;
  manifest: object;
  files: Array<{ archivePath: string; contents: string }>;
  directories?: string[];
}) {
  const tempDir = await makeTempDir("phoenix-restore-archive-");
  const rootDir = path.join(tempDir, options.archiveRoot);
  await fs.mkdir(rootDir, { recursive: true });
  await fs.writeFile(path.join(rootDir, "manifest.json"), `${JSON.stringify(options.manifest, null, 2)}\n`, "utf8");
  for (const directory of options.directories ?? []) {
    await fs.mkdir(path.join(tempDir, directory), { recursive: true });
  }
  for (const file of options.files) {
    const targetPath = path.join(tempDir, file.archivePath);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, file.contents, "utf8");
  }
  const archivePath = path.join(tempDir, `${options.archiveRoot}.tar.gz`);
  await tar.c({ file: archivePath, gzip: true, cwd: tempDir }, [options.archiveRoot]);
  return archivePath;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((entry) => fs.rm(entry, { recursive: true, force: true })));
});

describe("restoreBackupArchive", () => {
  it("validates with openclaw backup verify and skips writes during dry-run", async () => {
    const homeDir = await makeTempDir("phoenix-restore-home-");
    const currentStateDir = path.join(homeDir, ".openclaw");
    const currentConfigPath = path.join(currentStateDir, "openclaw.json");
    const sourceStateDir = path.join("/tmp", "phoenix-source-state");
    const sourceConfigPath = path.join(sourceStateDir, "openclaw.json");
    const archiveRoot = "2026-03-09T00-00-00.000Z-openclaw-backup";
    const markerPath = path.join(homeDir, "verify-called.txt");
    const archivePath = await buildArchiveFixture({
      archiveRoot,
      manifest: {
        schemaVersion: 1,
        archiveRoot,
        createdAt: "2026-03-09T00:00:00.000Z",
        paths: {
          stateDir: sourceStateDir,
          configPath: sourceConfigPath,
          oauthDir: path.join(sourceStateDir, "credentials"),
        },
        assets: [
          {
            kind: "config",
            sourcePath: sourceConfigPath,
            archivePath: buildBackupArchivePath(archiveRoot, sourceConfigPath),
          },
        ],
      },
      files: [
        {
          archivePath: buildBackupArchivePath(archiveRoot, sourceConfigPath),
          contents: '{"phoenix":true}\n',
        },
      ],
    });
    const openclawBin = await createFakeOpenClaw(homeDir, markerPath, archiveRoot, 1);

    const result = await restoreBackupArchive({
      archivePath,
      dryRun: true,
      env: {
        ...process.env,
        HOME: homeDir,
        OPENCLAW_STATE_DIR: currentStateDir,
      },
      openclawBin,
      yes: true,
      log: () => {},
      error: () => {},
    });

    expect(result.dryRun).toBe(true);
    await expect(fs.readFile(markerPath, "utf8")).resolves.toBe(archivePath);
    await expect(fs.access(currentConfigPath)).rejects.toBeTruthy();
  });

  it("requires confirmation when --yes is not supplied", async () => {
    const homeDir = await makeTempDir("phoenix-restore-confirm-");
    const currentStateDir = path.join(homeDir, ".openclaw");
    const currentConfigPath = path.join(currentStateDir, "openclaw.json");
    const sourceStateDir = path.join("/tmp", "phoenix-confirm-source");
    const sourceConfigPath = path.join(sourceStateDir, "openclaw.json");
    const archiveRoot = "2026-03-09T00-00-00.000Z-openclaw-backup";
    const markerPath = path.join(homeDir, "verify-called.txt");
    const archivePath = await buildArchiveFixture({
      archiveRoot,
      manifest: {
        schemaVersion: 1,
        archiveRoot,
        createdAt: "2026-03-09T00:00:00.000Z",
        paths: {
          stateDir: sourceStateDir,
          configPath: sourceConfigPath,
        },
        assets: [
          {
            kind: "config",
            sourcePath: sourceConfigPath,
            archivePath: buildBackupArchivePath(archiveRoot, sourceConfigPath),
          },
        ],
      },
      files: [
        {
          archivePath: buildBackupArchivePath(archiveRoot, sourceConfigPath),
          contents: '{"confirmed":false}\n',
        },
      ],
    });
    const openclawBin = await createFakeOpenClaw(homeDir, markerPath, archiveRoot, 1);

    await expect(
      restoreBackupArchive({
        archivePath,
        env: {
          ...process.env,
          HOME: homeDir,
          OPENCLAW_STATE_DIR: currentStateDir,
        },
        openclawBin,
        log: () => {},
        error: () => {},
        confirm: async () => false,
      }),
    ).rejects.toThrow(/restore cancelled/i);
    await expect(fs.access(currentConfigPath)).rejects.toBeTruthy();
  });

  it("restores directory payloads into the current Phoenix state paths", async () => {
    const homeDir = await makeTempDir("phoenix-restore-write-");
    const currentStateDir = path.join(homeDir, ".openclaw");
    const sourceStateDir = path.join("/tmp", "phoenix-write-source");
    const archiveRoot = "2026-03-09T00-00-00.000Z-openclaw-backup";
    const markerPath = path.join(homeDir, "verify-called.txt");
    const stateArchivePath = buildBackupArchivePath(archiveRoot, sourceStateDir);
    const archivePath = await buildArchiveFixture({
      archiveRoot,
      manifest: {
        schemaVersion: 1,
        archiveRoot,
        createdAt: "2026-03-09T00:00:00.000Z",
        paths: {
          stateDir: sourceStateDir,
          configPath: path.join(sourceStateDir, "openclaw.json"),
          oauthDir: path.join(sourceStateDir, "credentials"),
        },
        assets: [
          {
            kind: "state",
            sourcePath: sourceStateDir,
            archivePath: stateArchivePath,
          },
        ],
      },
      files: [
        {
          archivePath: path.posix.join(stateArchivePath, "openclaw.json"),
          contents: '{"restored":true}\n',
        },
        {
          archivePath: path.posix.join(stateArchivePath, "agents", "main", "agent", "auth-profiles.json"),
          contents: '{"profiles":[]}\n',
        },
      ],
      directories: [path.posix.join(stateArchivePath, "agents", "main", "agent")],
    });
    const openclawBin = await createFakeOpenClaw(homeDir, markerPath, archiveRoot, 1);

    const result = await restoreBackupArchive({
      archivePath,
      env: {
        ...process.env,
        HOME: homeDir,
        OPENCLAW_STATE_DIR: currentStateDir,
      },
      openclawBin,
      yes: true,
      log: () => {},
      error: () => {},
    });

    expect(result.restoredPaths).toEqual([currentStateDir]);
    expect(result.operation).toMatchObject({ origin: "manual", operation: "restore", status: "ok" });
    await expect(fs.readFile(path.join(currentStateDir, "openclaw.json"), "utf8")).resolves.toContain(
      '"restored":true',
    );
    await expect(
      fs.readFile(path.join(currentStateDir, "agents", "main", "agent", "auth-profiles.json"), "utf8"),
    ).resolves.toContain('"profiles"');
    const snapshot = await buildPhoenixWebSnapshot({
      env: { ...process.env, HOME: homeDir, OPENCLAW_STATE_DIR: currentStateDir },
      outputDir: path.dirname(archivePath),
      timelineLimit: 5,
    });
    expect(snapshot.overview.latestRestore?.result).toMatchObject({ archivePath, restoredPaths: [currentStateDir] });
    expect(snapshot.config.origins.manual).toMatchObject({ outputDir: path.dirname(archivePath), dryRun: false });
  });

  it("rejects symlinked restore targets", async () => {
    const homeDir = await makeTempDir("phoenix-restore-symlink-");
    const realStateDir = path.join(homeDir, "real-state");
    const symlinkStateDir = path.join(homeDir, ".openclaw");
    await fs.mkdir(realStateDir, { recursive: true });
    await fs.symlink(realStateDir, symlinkStateDir);
    const sourceStateDir = path.join("/tmp", "phoenix-symlink-source");
    const sourceConfigPath = path.join(sourceStateDir, "openclaw.json");
    const archiveRoot = "2026-03-09T00-00-00.000Z-openclaw-backup";
    const markerPath = path.join(homeDir, "verify-called.txt");
    const archivePath = await buildArchiveFixture({
      archiveRoot,
      manifest: {
        schemaVersion: 1,
        archiveRoot,
        createdAt: "2026-03-09T00:00:00.000Z",
        paths: {
          stateDir: sourceStateDir,
          configPath: sourceConfigPath,
        },
        assets: [
          {
            kind: "config",
            sourcePath: sourceConfigPath,
            archivePath: buildBackupArchivePath(archiveRoot, sourceConfigPath),
          },
        ],
      },
      files: [
        {
          archivePath: buildBackupArchivePath(archiveRoot, sourceConfigPath),
          contents: '{"unsafe":true}\n',
        },
      ],
    });
    const openclawBin = await createFakeOpenClaw(homeDir, markerPath, archiveRoot, 1);

    await expect(
      restoreBackupArchive({
        archivePath,
        env: {
          ...process.env,
          HOME: homeDir,
          OPENCLAW_STATE_DIR: symlinkStateDir,
        },
        openclawBin,
        yes: true,
        log: () => {},
        error: () => {},
      }),
    ).rejects.toThrow(/symlink/i);
  });
});