import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PhoenixWebSnapshot } from "./web-contract.js";
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

async function waitForCompletion<T>(getValue: () => T | Promise<T | undefined> | undefined, timeoutMs = 5_000): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await getValue();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for Phoenix web action completion");
}

function buildSnapshot(overrides: Partial<PhoenixWebSnapshot> = {}): PhoenixWebSnapshot {
  return {
    schemaVersion: 1,
    overview: {
      schemaVersion: 1,
      generatedAt: "2026-03-12T10:00:00.000Z",
      latestByOrigin: {},
      archiveCount: 0,
      ...overrides.overview,
    },
    timeline: {
      schemaVersion: 1,
      generatedAt: "2026-03-12T10:00:00.000Z",
      entries: [],
      runs: [],
      ...overrides.timeline,
    },
    config: {
      schemaVersion: 1,
      generatedAt: "2026-03-12T10:00:00.000Z",
      origins: {},
      ...overrides.config,
    },
    archives: {
      schemaVersion: 1,
      generatedAt: "2026-03-12T10:00:00.000Z",
      archives: [],
      ...overrides.archives,
    },
    setup: {
      schemaVersion: 1,
      generatedAt: "2026-03-12T10:00:00.000Z",
      items: [],
      backupReadiness: {
        state: "ready",
        title: "Backup-only readiness is clear",
        summary: "Phoenix has what it needs for minimal backup-only watch coverage.",
      },
      selfHealReadiness: {
        state: "ready",
        title: "Self-heal readiness is clear",
        summary: "Phoenix can validate health and roll back automatically.",
      },
      commands: [],
      ...overrides.setup,
    },
    ...overrides,
  };
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
      loadSnapshot: async () => buildSnapshot(),
    });

    const started = await controller.start("backup-now");
    const rejected = await controller.start("health-check-now");

    expect(started).toMatchObject({ ok: true, state: { runningMutation: { action: "backup-now" } } });
    expect(rejected).toMatchObject({ ok: false, state: { runningMutation: { action: "backup-now" } } });

    const completed = await waitForCompletion(async () => (await controller.getState()).lastCompleted);
    const snapshot = await buildPhoenixWebSnapshot({ outputDir, timelineLimit: 5 });

    expect((await controller.getState()).runningMutation).toBeUndefined();
    expect(completed.action).toBe("backup-now");
    expect(completed.status).toBe("ok");
    expect(completed.summary).toContain("Manual backup created");
    expect(completed.actionResult).toBeDefined();
    expect(completed.actionResult?.retention?.deleted.length).toBe(1);
    expect(snapshot.overview.latestAction).toMatchObject({
      origin: "manual",
      operation: "backup-cycle",
      status: "ok",
    });
    expect(snapshot.overview.latestWebAction?.result).toMatchObject({
      trigger: { source: "web-console", request: "backup-now" },
      operation: "backup-cycle",
    });
    expect(snapshot.overview.latestAction?.backup?.archivePath).toContain(`manual-web${OPENCLAW_BACKUP_ARCHIVE_SUFFIX}`);
  });

  it("records manual health checks with structured unhealthy results", { timeout: 10_000 }, async () => {
    const outputDir = await makeTempDir("phoenix-web-health-");
    const openclawBin = await createFakeOpenClaw({
      status: { gateway: { reachable: false, misconfigured: false } },
    });
    const controller = createPhoenixWebActionController({
      openclawBin,
      outputDir,
      retain: 2,
      loadSnapshot: async () => buildSnapshot(),
    });

    const started = await controller.start("health-check-now");
    const completed = await waitForCompletion(async () => (await controller.getState()).lastCompleted, 8_000);
    const snapshot = await buildPhoenixWebSnapshot({ outputDir, timelineLimit: 5 });

    expect(started).toMatchObject({ ok: true, state: { runningMutation: { action: "health-check-now" } } });
    expect(completed.action).toBe("health-check-now");
    expect(completed.status).toBe("warning");
    expect(completed.summary).toContain("Manual health check completed and reported unhealthy status");
    expect(snapshot.overview.latestAction).toMatchObject({
      origin: "manual",
      operation: "health-check",
      status: "warning",
    });
    expect(snapshot.overview.latestWebAction?.result).toMatchObject({
      trigger: { source: "web-console", request: "health-check-now" },
      operation: "health-check",
    });
    expect(snapshot.overview.latestHealth?.result).toMatchObject({
      attempted: true,
      healthy: false,
      reason: "gateway is unreachable in openclaw status --json",
    });
  });

  it("starts and stops a web-owned watch session, exposing runtime state and exclusive capabilities", async () => {
    const outputDir = await makeTempDir("phoenix-web-watch-");
    let closed = false;
    let resolveClosed = () => {};
    const closedPromise = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const controller = createPhoenixWebActionController({
      openclawBin: "openclaw",
      outputDir,
      retain: 2,
      loadSnapshot: async () => buildSnapshot(),
      startWatch: async () => ({
        close: async () => {
          closed = true;
          resolveClosed();
        },
        closed: closedPromise,
      }),
    });

    const started = await controller.start("watch-start", {
      selfHeal: true,
      notification: {
        enabled: true,
        policy: "all",
        target: { to: "ops@example.com", channel: "phoenix" },
      },
    });

    expect(started).toMatchObject({
      ok: true,
      state: {
        watch: {
          status: "running",
          selfHeal: true,
          notification: {
            enabled: true,
            policy: "all",
            target: { to: "ops@example.com", channel: "phoenix" },
          },
        },
      },
    });

    const duringWatch = await controller.getState();
    expect(duringWatch.capabilities["watch-stop"]).toMatchObject({ enabled: true });
    expect(duringWatch.capabilities["backup-now"]).toMatchObject({ enabled: false });
    expect(duringWatch.capabilities["hook-install"]).toMatchObject({ enabled: false });

    const rejected = await controller.start("backup-now");
    expect(rejected).toMatchObject({
      ok: false,
      error: expect.stringContaining("watch"),
      state: {
        watch: { status: "running" },
      },
    });

    const stopped = await controller.start("watch-stop");
    expect(stopped).toMatchObject({
      ok: true,
      state: {
        watch: { status: "stopped" },
        lastCompleted: { action: "watch-stop", status: "ok" },
      },
    });
    expect(closed).toBe(true);
  });

  it("runs hook install, hook run, and hook remove through injected implementations", async () => {
    const outputDir = await makeTempDir("phoenix-web-hook-");
    const observed: string[] = [];
    const controller = createPhoenixWebActionController({
      openclawBin: "openclaw",
      outputDir,
      retain: 2,
      phoenixCommand: ["node", "./dist/cli.js"],
      loadSnapshot: async () => buildSnapshot({
        config: {
          schemaVersion: 1,
          generatedAt: "2026-03-12T10:00:00.000Z",
          origins: {
            hook: {
              outputDir,
              installed: false,
              notification: { enabled: false, policy: "off", targetConfigured: false },
            },
          },
        },
      }),
      installHook: async (payload) => {
        observed.push(`install:${payload.eventKey}:${payload.notification?.policy ?? "off"}`);
        return {
          configPath: "/tmp/openclaw.json",
          hookDir: "/tmp/hooks/openclaw-phoenix-backup-rollback",
          eventKey: payload.eventKey,
          changed: true,
        };
      },
      removeHook: async () => {
        observed.push("remove");
        return {
          configPath: "/tmp/openclaw.json",
          hookDir: "/tmp/hooks/openclaw-phoenix-backup-rollback",
          changed: true,
        };
      },
      runHook: async (payload) => {
        observed.push(`run:${payload.notification?.target?.to ?? "none"}`);
        return {
          ok: true,
          healthy: true,
          healthReason: "gateway reachable",
          rollbackRestored: false,
          retentionDeleted: [],
          notificationDelivery: { results: [] },
          operation: {
            schemaVersion: 1,
            id: "hook-operation",
            origin: "hook",
            operation: "recovery-cycle",
            status: "ok",
            startedAt: "2026-03-12T10:00:00.000Z",
            finishedAt: "2026-03-12T10:00:05.000Z",
            summary: "Hook run succeeded.",
            config: {
              outputDir,
              retain: 2,
              notification: { enabled: false, policy: "off", targetConfigured: false },
            },
          },
        };
      },
    });

    const install = await controller.start("hook-install", {
      eventKey: "gateway:startup",
      notification: { enabled: true, policy: "exceptional-only", target: { to: "ops@example.com" } },
    });
    const run = await controller.start("hook-run", {
      notification: { enabled: true, policy: "all", target: { to: "ops@example.com" } },
    });

    expect(install).toMatchObject({ ok: true, state: { lastCompleted: { action: "hook-install", status: "ok" } } });
    expect(run).toMatchObject({ ok: true, state: { lastCompleted: { action: "hook-run", status: "ok" } } });
    expect(observed).toContain("install:gateway:startup:exceptional-only");
    expect(observed).toContain("run:ops@example.com");

    const removable = createPhoenixWebActionController({
      openclawBin: "openclaw",
      outputDir,
      retain: 2,
      phoenixCommand: ["node", "./dist/cli.js"],
      loadSnapshot: async () => buildSnapshot({
        config: {
          schemaVersion: 1,
          generatedAt: "2026-03-12T10:00:00.000Z",
          origins: {
            hook: {
              outputDir,
              installed: true,
              eventKey: "gateway:startup",
              hookDir: "/tmp/hooks/openclaw-phoenix-backup-rollback",
              notification: { enabled: false, policy: "off", targetConfigured: false },
            },
          },
        },
      }),
      removeHook: async () => {
        observed.push("remove-installed");
        return {
          configPath: "/tmp/openclaw.json",
          hookDir: "/tmp/hooks/openclaw-phoenix-backup-rollback",
          changed: true,
        };
      },
    });

    const remove = await removable.start("hook-remove");
    expect(remove).toMatchObject({ ok: true, state: { lastCompleted: { action: "hook-remove", status: "ok" } } });
    expect(observed).toContain("remove-installed");
  });

  it("rejects web watch self-heal and hook actions when readiness is blocked, and rejects hook remove when not installed", async () => {
    const outputDir = await makeTempDir("phoenix-web-guard-");
    const controller = createPhoenixWebActionController({
      openclawBin: "openclaw",
      outputDir,
      retain: 2,
      loadSnapshot: async () => buildSnapshot({
        config: {
          schemaVersion: 1,
          generatedAt: "2026-03-12T10:00:00.000Z",
          origins: {
            hook: {
              outputDir,
              installed: false,
              notification: { enabled: false, policy: "off", targetConfigured: false },
            },
          },
        },
        setup: {
          schemaVersion: 1,
          generatedAt: "2026-03-12T10:00:00.000Z",
          items: [],
          backupReadiness: {
            state: "ready",
            title: "Backup-only readiness is clear",
            summary: "Ready.",
          },
          selfHealReadiness: {
            state: "blocked",
            title: "Self-heal readiness is blocked",
            summary: "Resolve blockers.",
          },
          commands: [],
        },
      }),
    });

    const watchStart = await controller.start("watch-start", { selfHeal: true });
    const hookInstall = await controller.start("hook-install", { eventKey: "gateway:startup" });
    const hookRun = await controller.start("hook-run");
    const hookRemove = await controller.start("hook-remove");

    expect(watchStart).toMatchObject({ ok: false, error: expect.stringContaining("Self-heal readiness") });
    expect(hookInstall).toMatchObject({ ok: false, error: expect.stringContaining("Self-heal readiness") });
    expect(hookRun).toMatchObject({ ok: false, error: expect.stringContaining("Self-heal readiness") });
    expect(hookRemove).toMatchObject({ ok: false, error: expect.stringContaining("not installed") });
  });
});
