import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OPENCLAW_BACKUP_ARCHIVE_SUFFIX } from "./retention.js";
import { createPhoenixWebActionController } from "./web-actions.js";
import { buildPhoenixWebSnapshot } from "./web-contract.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

async function createFakeOpenClaw(options: {
  delayMs?: number;
  status?: Record<string, unknown>;
} = {}): Promise<string> {
  const root = await makeTempDir("phoenix-web-actions-");
  const scriptPath = path.join(root, "fake-openclaw.mjs");
  const script = `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const delayMs = ${options.delayMs ?? 0};
const status = ${JSON.stringify(options.status ?? { gateway: { reachable: true, misconfigured: false } })};
const archiveSuffix = ${JSON.stringify(OPENCLAW_BACKUP_ARCHIVE_SUFFIX)};
const args = process.argv.slice(2);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (args[0] === 'backup' && args[1] === 'create') {
  if (delayMs > 0) await sleep(delayMs);
  const outputIndex = args.indexOf('--output');
  const outputDir = outputIndex >= 0 ? args[outputIndex + 1] : process.cwd();
  fs.mkdirSync(outputDir, { recursive: true });
  const archivePath = path.join(outputDir, 'manual-web' + archiveSuffix);
  fs.writeFileSync(archivePath, 'backup-data');
  console.log(JSON.stringify({ archivePath, createdAt: new Date().toISOString() }));
  process.exit(0);
}

if (args[0] === 'status' && args[1] === '--json') {
  if (delayMs > 0) await sleep(delayMs);
  console.log(JSON.stringify(status));
  process.exit(0);
}

console.error('unexpected args', args.join(' '));
process.exit(1);
`;
  await fs.writeFile(scriptPath, script, { mode: 0o755 });
  return scriptPath;
}

async function waitForCompletion<T>(getValue: () => T | undefined, timeoutMs = 5_000): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = getValue();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for Phoenix web action completion");
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("createPhoenixWebActionController", () => {
  it("records manual backup actions and enforces one running browser action at a time", async () => {
    const outputDir = await makeTempDir("phoenix-web-output-");
    await fs.writeFile(path.join(outputDir, `old-a${OPENCLAW_BACKUP_ARCHIVE_SUFFIX}`), "a");
    await fs.writeFile(path.join(outputDir, `old-b${OPENCLAW_BACKUP_ARCHIVE_SUFFIX}`), "b");
    const openclawBin = await createFakeOpenClaw({ delayMs: 75 });
    const controller = createPhoenixWebActionController({
      openclawBin,
      outputDir,
      retain: 2,
    });

    const started = await controller.start("backup-now");
    const rejected = await controller.start("health-check-now");

    expect(started).toMatchObject({ ok: true, state: { running: { action: "backup-now" } } });
    expect(rejected).toMatchObject({ ok: false, state: { running: { action: "backup-now" } } });

    const completed = await waitForCompletion(() => controller.getState().lastCompleted);
    const snapshot = await buildPhoenixWebSnapshot({ outputDir, timelineLimit: 5 });

    expect(controller.getState().running).toBeUndefined();
    expect(completed.action).toBe("backup-now");
    expect(completed.status).toBe("ok");
    expect(completed.summary).toContain("Manual backup created");
    expect(completed.actionResult.retention?.deleted.length).toBe(1);
    expect(snapshot.overview.latestAction).toMatchObject({
      origin: "manual",
      operation: "backup-cycle",
      status: "ok",
    });
    expect(snapshot.overview.latestAction?.backup?.archivePath).toContain(`manual-web${OPENCLAW_BACKUP_ARCHIVE_SUFFIX}`);
  });

  it("records manual health checks with structured unhealthy results", async () => {
    const outputDir = await makeTempDir("phoenix-web-health-");
    const openclawBin = await createFakeOpenClaw({
      status: { gateway: { reachable: false, misconfigured: false } },
    });
    const controller = createPhoenixWebActionController({
      openclawBin,
      outputDir,
      retain: 2,
    });

    const started = await controller.start("health-check-now");
    const completed = await waitForCompletion(() => controller.getState().lastCompleted);
    const snapshot = await buildPhoenixWebSnapshot({ outputDir, timelineLimit: 5 });

    expect(started).toMatchObject({ ok: true, state: { running: { action: "health-check-now" } } });
    expect(completed.action).toBe("health-check-now");
    expect(completed.status).toBe("warning");
    expect(completed.summary).toContain("Manual health check reported unhealthy status");
    expect(snapshot.overview.latestAction).toMatchObject({
      origin: "manual",
      operation: "health-check",
      status: "warning",
    });
    expect(snapshot.overview.latestHealth?.result).toMatchObject({
      attempted: true,
      healthy: false,
      reason: "gateway is unreachable in openclaw status --json",
    });
  });
});