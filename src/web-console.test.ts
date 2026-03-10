import { afterEach, describe, expect, it } from "vitest";
import {
  renderPhoenixWebConsoleErrorPage,
  renderPhoenixWebConsolePage,
  startPhoenixWebConsole,
  type PhoenixWebConsoleServer,
} from "./web-console.js";
import type { PhoenixWebSnapshot } from "./web-contract.js";
import type { PhoenixWebActionController, PhoenixWebActionState } from "./web-actions.js";

const servers: PhoenixWebConsoleServer[] = [];

function buildSnapshot(overrides: Partial<PhoenixWebSnapshot> = {}): PhoenixWebSnapshot {
  return {
    schemaVersion: 1,
    overview: {
      schemaVersion: 1,
      generatedAt: "2026-03-10T12:00:00.000Z",
      latestByOrigin: {},
      archiveCount: 0,
      ...overrides.overview,
    },
    timeline: {
      schemaVersion: 1,
      generatedAt: "2026-03-10T12:00:00.000Z",
      entries: [],
      ...overrides.timeline,
    },
    config: {
      schemaVersion: 1,
      generatedAt: "2026-03-10T12:00:00.000Z",
      origins: {},
      ...overrides.config,
    },
    archives: {
      schemaVersion: 1,
      generatedAt: "2026-03-10T12:00:00.000Z",
      archives: [],
      ...overrides.archives,
    },
    setup: {
      schemaVersion: 1,
      generatedAt: "2026-03-10T12:00:00.000Z",
      items: [],
      backupReadiness: {
        state: "blocked",
        title: "Backup-only readiness is blocked",
        summary: "Resolve the required blockers before relying on Phoenix backup watch coverage.",
      },
      selfHealReadiness: {
        state: "blocked",
        title: "Self-heal readiness is blocked",
        summary: "Fix the required backup/setup blockers first, then enable or verify a self-heal path.",
      },
      commands: [],
      ...overrides.setup,
    },
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("renderPhoenixWebConsolePage", () => {
  it("renders explicit empty states for overview and activity views", () => {
    const snapshot = buildSnapshot();

    const overviewHtml = renderPhoenixWebConsolePage(snapshot, "overview");
    const activityHtml = renderPhoenixWebConsolePage(snapshot, "activity");

    expect(overviewHtml).toContain("This read-only console has no watch, hook, or archive activity to summarize yet");
    expect(overviewHtml).toContain("Data freshness");
    expect(overviewHtml).toContain("Browser checks for newer data every 15 second(s)");
    expect(overviewHtml).toContain("Refresh now");
    expect(overviewHtml).toContain("Manual browser actions");
    expect(overviewHtml).toContain("Run backup now");
    expect(overviewHtml).toContain("Run health check now");
    expect(overviewHtml).toContain("No backup cycle has been recorded yet");
    expect(overviewHtml).toContain("No health check has been recorded yet");
    expect(activityHtml).toContain("Phoenix has not recorded any actions yet");
  });

  it("renders degraded self-heal state with watch and hook labels", () => {
    const snapshot = buildSnapshot({
      overview: {
        schemaVersion: 1,
        generatedAt: "2026-03-10T12:00:00.000Z",
        latestAction: {
          schemaVersion: 1,
          id: "op-1",
          origin: "hook",
          operation: "recovery-cycle",
          status: "warning",
          startedAt: "2026-03-10T11:58:00.000Z",
          finishedAt: "2026-03-10T12:00:00.000Z",
          summary: "Hook recovery restored a known-good archive.",
          config: {
            outputDir: "/tmp/phoenix",
            selfHeal: true,
            notification: { enabled: true, policy: "all", targetConfigured: true },
          },
          backup: { attempted: true, archivePath: "/tmp/phoenix/latest.tar.gz" },
          health: { attempted: true, healthy: false, reason: "gateway unreachable" },
          rollback: { needed: true, attempted: true, restored: true, archivePath: "/tmp/phoenix/known-good.tar.gz" },
          notification: { status: "failed", events: [], delivery: [] },
        },
        latestByOrigin: {},
        latestBackup: {
          operationId: "op-1",
          origin: "watch",
          finishedAt: "2026-03-10T12:00:00.000Z",
          actionStatus: "warning",
          result: { attempted: true, archivePath: "/tmp/phoenix/latest.tar.gz" },
        },
        latestHealth: {
          operationId: "op-1",
          origin: "hook",
          finishedAt: "2026-03-10T12:00:00.000Z",
          actionStatus: "warning",
          result: { attempted: true, healthy: false, reason: "gateway unreachable" },
        },
        latestRollback: {
          operationId: "op-1",
          origin: "hook",
          finishedAt: "2026-03-10T12:00:00.000Z",
          actionStatus: "warning",
          result: { needed: true, attempted: true, restored: true, archivePath: "/tmp/phoenix/known-good.tar.gz" },
        },
        latestNotification: {
          operationId: "op-1",
          origin: "hook",
          finishedAt: "2026-03-10T12:00:00.000Z",
          actionStatus: "warning",
          result: { status: "failed", events: [], delivery: [] },
        },
        latestKnownGoodArchivePath: "/tmp/phoenix/known-good.tar.gz",
        archiveCount: 2,
      },
      config: {
        schemaVersion: 1,
        generatedAt: "2026-03-10T12:00:00.000Z",
        deployment: {
          configPath: "/tmp/.openclaw/openclaw.json",
          stateDir: "/tmp/.openclaw",
          oauthDir: "/tmp/.openclaw/credentials",
          warnings: ["watch target refresh skipped config-derived paths: config parse failed"],
        },
        origins: {
          watch: {
            outputDir: "/tmp/phoenix",
            selfHeal: false,
            retain: 5,
            lastRunAt: "2026-03-10T11:59:00.000Z",
            notification: { enabled: false, policy: "off", targetConfigured: false },
          },
          hook: {
            outputDir: "/tmp/phoenix",
            selfHeal: true,
            retain: 5,
            installed: true,
            eventKey: "gateway:startup",
            hookDir: "/tmp/.openclaw/hooks/openclaw-phoenix-backup-rollback",
            notification: { enabled: true, policy: "all", targetConfigured: true },
          },
        },
      },
    });

    const html = renderPhoenixWebConsolePage(snapshot, "overview");

    expect(html).toContain("Degraded");
    expect(html).toContain("Latest meaningful outcome");
    expect(html).toContain("Phoenix looks degraded because the latest recovery check turned unhealthy (gateway unreachable)");
    expect(html).toContain("Rollback happened because Phoenix saw an unhealthy result (gateway unreachable)");
    expect(html).toContain("Notification failed");
    expect(html).toContain("remote operators may not have seen it");
    expect(html).toContain("Watch mode");
    expect(html).toContain("Backup-only");
    expect(html).toContain("Hook origin");
    expect(html).toContain("Installed (self-heal)");
    expect(html).toContain("gateway unreachable");
    expect(html).toContain("Latest known-good");
  });

  it("explains limited backup-only coverage and aging snapshots", () => {
    const snapshot = buildSnapshot({
      overview: {
        schemaVersion: 1,
        generatedAt: "2026-03-10T12:30:00.000Z",
        latestAction: {
          schemaVersion: 1,
          id: "op-2",
          origin: "watch",
          operation: "backup-cycle",
          status: "ok",
          startedAt: "2026-03-10T11:58:00.000Z",
          finishedAt: "2026-03-10T12:00:00.000Z",
          summary: "Watch backup cycle created latest.tar.gz.",
          config: {
            outputDir: "/tmp/phoenix",
            selfHeal: false,
            notification: { enabled: false, policy: "off", targetConfigured: false },
          },
          backup: { attempted: true, archivePath: "/tmp/phoenix/latest.tar.gz" },
          retention: { kept: ["/tmp/phoenix/latest.tar.gz"], deleted: [] },
        },
        latestByOrigin: {},
        latestBackup: {
          operationId: "op-2",
          origin: "watch",
          finishedAt: "2026-03-10T12:00:00.000Z",
          actionStatus: "ok",
          result: { attempted: true, archivePath: "/tmp/phoenix/latest.tar.gz" },
        },
        archiveCount: 1,
      },
      config: {
        schemaVersion: 1,
        generatedAt: "2026-03-10T12:30:00.000Z",
        origins: {
          watch: {
            outputDir: "/tmp/phoenix",
            selfHeal: false,
            retain: 5,
            lastRunAt: "2026-03-10T12:00:00.000Z",
            notification: { enabled: false, policy: "off", targetConfigured: false },
          },
        },
      },
    });

    const html = renderPhoenixWebConsolePage(snapshot, "overview");

    expect(html).toContain("Limited");
    expect(html).toContain("backup-only cycle did not prove the live system was healthy");
    expect(html).toContain("Aging data");
    expect(html).toContain("this console does not claim anything newer until another snapshot is produced");
  });

  it("renders the guided setup view with readiness, priorities, and preview commands", () => {
    const snapshot = buildSnapshot({
      setup: {
        schemaVersion: 1,
        generatedAt: "2026-03-10T12:00:00.000Z",
        backupReadiness: {
          state: "needs-attention",
          title: "Backup-only readiness has warnings",
          summary: "Backup-only coverage can run, but Phoenix has warnings you should review.",
        },
        selfHealReadiness: {
          state: "blocked",
          title: "Self-heal readiness is blocked",
          summary: "Fix blockers before depending on self-heal.",
        },
        items: [
          {
            id: "config-path",
            section: "environment",
            priority: "required",
            severity: "blocker",
            title: "OpenClaw config path",
            summary: "Point Phoenix at the active openclaw.json.",
            value: "/tmp/.openclaw/openclaw.json",
          },
          {
            id: "output-dir",
            section: "backup",
            priority: "required",
            severity: "info",
            title: "Backup output directory",
            summary: "Phoenix can create this directory on the first run.",
            value: "/tmp/phoenix",
          },
          {
            id: "self-heal-mode",
            section: "self-heal",
            priority: "optional",
            severity: "info",
            title: "Self-heal protection",
            summary: "Add --self-heal when you want automatic rollback.",
          },
        ],
        commands: [
          {
            id: "backup-watch",
            title: "Apply backup-only watch settings",
            summary: "Run Phoenix in backup-only mode.",
            command: "openclaw-phoenix watch --config /tmp/.openclaw/openclaw.json --output /tmp/phoenix --retain 100 --notify off",
            appliesChanges: false,
          },
        ],
      },
    });

    const html = renderPhoenixWebConsolePage(snapshot, "setup");

    expect(html).toContain("Guided setup summary");
    expect(html).toContain("Backup-only readiness has warnings");
    expect(html).toContain("Hard blocker");
    expect(html).toContain("Required");
    expect(html).toContain("Preview only");
    expect(html).toContain("openclaw-phoenix watch");
  });
});

describe("startPhoenixWebConsole", () => {
  it("serves HTML views and the snapshot API", async () => {
    const snapshot = buildSnapshot({
      overview: {
        schemaVersion: 1,
        generatedAt: "2026-03-10T12:00:00.000Z",
        latestByOrigin: {},
        archiveCount: 1,
      },
      archives: {
        schemaVersion: 1,
        generatedAt: "2026-03-10T12:00:00.000Z",
        archives: [
          {
            archivePath: "/tmp/phoenix/backup.tar.gz",
            fileName: "backup.tar.gz",
            mtimeAt: "2026-03-10T12:00:00.000Z",
            sizeBytes: 2048,
            roles: ["latest-known-good"],
          },
        ],
      },
    });
    const server = await startPhoenixWebConsole({
      host: "127.0.0.1",
      port: 0,
      loadSnapshot: async () => snapshot,
    });
    servers.push(server);

    const overview = await fetch(`${server.url}/overview`);
    const setup = await fetch(`${server.url}/setup`);
    const api = await fetch(`${server.url}/api/snapshot`);

    expect(overview.status).toBe(200);
    expect(await overview.text()).toContain("OpenClaw Phoenix Console");
    expect(setup.status).toBe(200);
    expect(await setup.text()).toContain("Guided setup summary");
    expect(api.status).toBe(200);
    expect(await api.json()).toMatchObject({ schemaVersion: 1, archives: { archives: [{ fileName: "backup.tar.gz" }] } });
  });

  it("renders an explicit error page when the snapshot loader fails", async () => {
    const server = await startPhoenixWebConsole({
      host: "127.0.0.1",
      port: 0,
      loadSnapshot: async () => {
        throw new Error("snapshot load failed");
      },
    });
    servers.push(server);

    const response = await fetch(`${server.url}/configuration`);
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).toContain("Configuration unavailable");
    expect(body).toContain("snapshot load failed");
    expect(renderPhoenixWebConsoleErrorPage({ error: new Error("boom"), pathname: "/overview", view: "overview" })).toContain("Overview unavailable");
  });

  it("starts manual browser actions through the narrow action API", async () => {
    let state: PhoenixWebActionState = {};
    const actionController: PhoenixWebActionController = {
      getState: () => state,
      start: async (action) => {
        state = {
          running: {
            id: "run-1",
            action,
            startedAt: "2026-03-10T12:00:00.000Z",
          },
        };
        return { ok: true, state };
      },
    };
    const server = await startPhoenixWebConsole({
      host: "127.0.0.1",
      port: 0,
      actionController,
      loadSnapshot: async () => buildSnapshot(),
    });
    servers.push(server);

    const overview = await fetch(`${server.url}/overview`);
    const startAction = await fetch(`${server.url}/api/actions/backup-now`, { method: "POST" });
    const actionState = await fetch(`${server.url}/api/actions/state`);

    expect(overview.status).toBe(200);
    expect(await overview.text()).toContain("Manual browser actions");
    expect(startAction.status).toBe(202);
    expect(await startAction.json()).toMatchObject({
      ok: true,
      state: { running: { action: "backup-now" } },
    });
    expect(actionState.status).toBe(200);
    expect(await actionState.json()).toMatchObject({
      running: { action: "backup-now" },
    });
  });
});