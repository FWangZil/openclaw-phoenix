import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import * as tar from "tar";
import { afterEach, describe, expect, it } from "vitest";
import { resolvePhoenixCommand } from "./phoenix-command.js";
import { installPhoenixHook, PHOENIX_HOOK_NAME, removePhoenixHook } from "./hook-install.js";
import { buildBackupArchivePath } from "./paths.js";

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
  const tempDir = await makeTempDir("phoenix-hook-archive-");
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

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((entry) => fs.rm(entry, { recursive: true, force: true })));
});

describe("managed Phoenix hook", () => {
  it("installs a managed hook, rolls back on unhealthy status, and removes only Phoenix-owned entries", async () => {
    const homeDir = await makeTempDir("phoenix-hook-home-");
    const outputDir = path.join(homeDir, "archives");
    const stateDir = path.join(homeDir, ".openclaw");
    const configPath = path.join(stateDir, "openclaw.json");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify({
        hooks: {
          internal: {
            enabled: false,
            entries: {
              unrelated: { enabled: true, note: "keep-me" },
            },
          },
        },
      }, null, 2)}\n`,
      "utf8",
    );
    const liveConfigPath = path.join(stateDir, "runtime-config.json");
    await fs.writeFile(liveConfigPath, JSON.stringify({ version: "healthy" }), "utf8");
    const healthyStateDir = path.join("/tmp", "phoenix-source-state");
    const archiveRoot = "2026-03-09T00-00-00.000Z-openclaw-backup";
    const healthyArchive = await buildArchiveFixture({
      archiveRoot,
      manifest: {
        schemaVersion: 1,
        archiveRoot,
        createdAt: "2026-03-09T00:00:00.000Z",
        paths: {
          stateDir: healthyStateDir,
          configPath: path.join(healthyStateDir, "openclaw.json"),
          oauthDir: path.join(healthyStateDir, "credentials"),
        },
        assets: [
          {
            kind: "config",
            sourcePath: path.join(healthyStateDir, "runtime-config.json"),
            archivePath: buildBackupArchivePath(archiveRoot, path.join(healthyStateDir, "runtime-config.json")),
          },
        ],
      },
      files: [
        {
          archivePath: buildBackupArchivePath(archiveRoot, path.join(healthyStateDir, "runtime-config.json")),
          contents: JSON.stringify({ version: "healthy" }),
        },
      ],
    });
    const unhealthyArchive = await buildArchiveFixture({
      archiveRoot: "2026-03-09T01-00-00.000Z-openclaw-backup",
      manifest: {
        schemaVersion: 1,
        archiveRoot: "2026-03-09T01-00-00.000Z-openclaw-backup",
        createdAt: "2026-03-09T01:00:00.000Z",
        paths: {
          stateDir: healthyStateDir,
          configPath: path.join(healthyStateDir, "openclaw.json"),
          oauthDir: path.join(healthyStateDir, "credentials"),
        },
        assets: [
          {
            kind: "config",
            sourcePath: path.join(healthyStateDir, "runtime-config.json"),
            archivePath: buildBackupArchivePath(
              "2026-03-09T01-00-00.000Z-openclaw-backup",
              path.join(healthyStateDir, "runtime-config.json"),
            ),
          },
        ],
      },
      files: [
        {
          archivePath: buildBackupArchivePath(
            "2026-03-09T01-00-00.000Z-openclaw-backup",
            path.join(healthyStateDir, "runtime-config.json"),
          ),
          contents: JSON.stringify({ version: "broken-snapshot" }),
        },
      ],
    });
    const archiveQueuePath = path.join(homeDir, "archive-queue.json");
    const statusModePath = path.join(homeDir, "status-mode.txt");
    const restoreMarkerPath = path.join(homeDir, "restore-marker.txt");
    await fs.writeFile(archiveQueuePath, JSON.stringify([healthyArchive, unhealthyArchive]), "utf8");
    await fs.writeFile(statusModePath, "healthy", "utf8");
    const fakeOpenClawPath = path.join(homeDir, "fake-openclaw.mjs");
    await writeExecutableScript(
      fakeOpenClawPath,
      `#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
const args = process.argv.slice(2);
const queuePath = ${JSON.stringify(archiveQueuePath)};
const statusModePath = ${JSON.stringify(statusModePath)};
const restoreMarkerPath = ${JSON.stringify(restoreMarkerPath)};
if (args[0] === "backup" && args[1] === "create") {
  const queue = JSON.parse(await fs.readFile(queuePath, "utf8"));
  const nextArchive = queue.shift();
  await fs.writeFile(queuePath, JSON.stringify(queue), "utf8");
  const outputDir = args[args.indexOf("--output") + 1];
  await fs.mkdir(outputDir, { recursive: true });
  const target = path.join(outputDir, path.basename(nextArchive));
  await fs.copyFile(nextArchive, target);
  console.log(JSON.stringify({ archivePath: target, createdAt: "2026-03-09T00:00:00.000Z" }));
  process.exit(0);
}
if (args[0] === "backup" && args[1] === "verify") {
  await fs.writeFile(restoreMarkerPath, args[2], "utf8");
  console.log(JSON.stringify({
    ok: true,
    archivePath: args[2],
    archiveRoot: ${JSON.stringify(archiveRoot)},
    createdAt: "2026-03-09T00:00:00.000Z",
    runtimeVersion: "test-runtime",
    assetCount: 1,
    entryCount: 2,
  }));
  process.exit(0);
}
if (args[0] === "status" && args[1] === "--json") {
  const mode = (await fs.readFile(statusModePath, "utf8")).trim();
  const reachable = mode === "healthy";
  console.log(JSON.stringify({ gateway: { reachable, misconfigured: false } }));
  process.exit(0);
}
console.error("unexpected fake openclaw args: " + args.join(" "));
process.exit(1);
`,
    );
    const phoenixWrapperPath = path.join(homeDir, "openclaw-phoenix-wrapper.sh");
    await writeExecutableScript(
      phoenixWrapperPath,
      `#!/usr/bin/env bash
exec node --import tsx ${JSON.stringify(path.resolve("src/cli.ts"))} "$@"
`,
    );
    await installPhoenixHook({
      configPath,
      phoenixCommand: [phoenixWrapperPath],
      openclawBin: fakeOpenClawPath,
      outputDir,
      retain: 1,
      env: {
        ...process.env,
        HOME: homeDir,
      },
    });
    const installedConfig = JSON.parse(await fs.readFile(configPath, "utf8"));
    expect(installedConfig.hooks.internal.entries.unrelated).toEqual({ enabled: true, note: "keep-me" });
    expect(installedConfig.hooks.internal.entries[PHOENIX_HOOK_NAME].managedBy).toBe("openclaw-phoenix");
    const hookDir = path.join(stateDir, "hooks", PHOENIX_HOOK_NAME);
    const hookModule = (await import(pathToFileURL(path.join(hookDir, "handler.js")).href)) as {
      default?: (event: { messages: string[] }) => Promise<void>;
    };
    expect(typeof hookModule.default).toBe("function");
    const healthyEvent = { messages: [] as string[] };
    await hookModule.default?.(healthyEvent);
    expect(healthyEvent.messages).toEqual([]);
    const stateAfterHealthy = JSON.parse(await fs.readFile(path.join(outputDir, ".openclaw-phoenix-state.json"), "utf8"));
    expect(stateAfterHealthy.latestKnownGoodArchivePath).toContain("2026-03-09T00-00-00.000Z-openclaw-backup.tar.gz");
    await fs.writeFile(liveConfigPath, JSON.stringify({ version: "bad" }), "utf8");
    await fs.writeFile(statusModePath, "unhealthy", "utf8");
    const unhealthyEvent = { messages: [] as string[] };
    await hookModule.default?.(unhealthyEvent);
    expect(unhealthyEvent.messages[0]).toContain("rolled back");
    expect(JSON.parse(await fs.readFile(liveConfigPath, "utf8"))).toEqual({ version: "healthy" });
    const archivedFiles = (await fs.readdir(outputDir)).filter((entry) => entry.endsWith(".tar.gz")).sort();
    expect(archivedFiles).toHaveLength(2);
    expect(await fs.readFile(restoreMarkerPath, "utf8")).toContain("2026-03-09T00-00-00.000Z-openclaw-backup.tar.gz");
    await removePhoenixHook({
      configPath,
      env: {
        ...process.env,
        HOME: homeDir,
      },
    });
    const removedConfig = JSON.parse(await fs.readFile(configPath, "utf8"));
    expect(removedConfig.hooks.internal.enabled).toBe(false);
    expect(removedConfig.hooks.internal.entries).toEqual({ unrelated: { enabled: true, note: "keep-me" } });
    await expect(fs.stat(hookDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to mutate config when removing an unmanaged hook directory", async () => {
    const homeDir = await makeTempDir("phoenix-hook-remove-home-");
    const stateDir = path.join(homeDir, ".openclaw");
    const configPath = path.join(stateDir, "openclaw.json");
    const hookDir = path.join(stateDir, "hooks", PHOENIX_HOOK_NAME);
    await fs.mkdir(hookDir, { recursive: true });
    const originalConfig = {
      hooks: {
        internal: {
          enabled: true,
          entries: {
            [PHOENIX_HOOK_NAME]: { enabled: true, managedBy: "openclaw-phoenix" },
          },
        },
      },
    };
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(configPath, `${JSON.stringify(originalConfig, null, 2)}\n`, "utf8");

    await expect(removePhoenixHook({ configPath })).rejects.toThrow("Refusing to remove unmanaged hook directory");
    expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toEqual(originalConfig);
  });

  it("stores a node-based command when the current Phoenix entrypoint is a TypeScript file", async () => {
    const homeDir = await makeTempDir("phoenix-hook-command-home-");
    const stateDir = path.join(homeDir, ".openclaw");
    const configPath = path.join(stateDir, "openclaw.json");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(configPath, "{}\n", "utf8");
    const outputDir = path.join(homeDir, "archives");
    const fakeOpenClawPath = path.join(homeDir, "fake-openclaw.sh");
    await writeExecutableScript(fakeOpenClawPath, "#!/usr/bin/env bash\nexit 0\n");

    await installPhoenixHook({
      configPath,
      phoenixCommand: resolvePhoenixCommand({
        argv: ["node", "src/cli.ts"],
        execPath: "/opt/node/bin/node",
      }),
      openclawBin: fakeOpenClawPath,
      outputDir,
      retain: 2,
      env: {
        ...process.env,
        HOME: homeDir,
      },
    });

    const hookDir = path.join(stateDir, "hooks", PHOENIX_HOOK_NAME);
    const handler = await fs.readFile(path.join(hookDir, "handler.js"), "utf8");
    expect(handler).toContain('const PHOENIX_COMMAND = ["/opt/node/bin/node","--import","tsx"');
    expect(handler).toContain(JSON.stringify(path.resolve("src/cli.ts")));
  });
});