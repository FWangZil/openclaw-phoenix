import { afterEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import {
  derivePhoenixWebConsoleSurfacePosture,
  evaluatePhoenixWebManualActionRequest,
  PHOENIX_WEB_MANUAL_ACTION_HEADER,
  startPhoenixWebConsole,
  type PhoenixWebConsoleServer,
} from "./web-console.js";
import type { PhoenixWebSnapshot } from "./web-contract.js";
import type { PhoenixWebActionController, PhoenixWebActionState } from "./web-actions.js";

const servers: PhoenixWebConsoleServer[] = [];
const fixtureAssetRoot = fileURLToPath(new URL("./__fixtures__/web-console-app", import.meta.url));

function buildActionState(overrides: Partial<PhoenixWebActionState> = {}): PhoenixWebActionState {
  return {
    watch: {
      status: "stopped",
      ...overrides.watch,
    },
    capabilities: {
      "backup-now": { enabled: true },
      "health-check-now": { enabled: true },
      "watch-start": { enabled: true },
      "watch-stop": { enabled: false, reason: "Watch is not currently running." },
      "hook-install": { enabled: true },
      "hook-remove": { enabled: false, reason: "The managed Phoenix hook is not installed." },
      "hook-run": { enabled: true },
      ...overrides.capabilities,
    },
    ...overrides,
  };
}

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
      runs: [],
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
        summary: "Resolve blockers.",
      },
      selfHealReadiness: {
        state: "blocked",
        title: "Self-heal readiness is blocked",
        summary: "Resolve blockers.",
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

describe("startPhoenixWebConsole", () => {
  it("serves a Vite dev shell without requiring built assets", async () => {
    const server = await startPhoenixWebConsole({
      host: "127.0.0.1",
      port: 0,
      devAssetOrigin: "http://127.0.0.1:5173",
      loadSnapshot: async () => buildSnapshot(),
    });
    servers.push(server);

    const overview = await fetch(`${server.url}/overview`);

    expect(overview.status).toBe(200);
    const overviewHtml = await overview.text();
    expect(overviewHtml).toContain("window.$RefreshReg$ = () => {};");
    expect(overviewHtml).toContain("window.__vite_plugin_react_preamble_installed__ = true;");
    expect(overviewHtml).toContain('<script type="module" src="http://127.0.0.1:5173/@vite/client"></script>');
    expect(overviewHtml).toContain('src="http://127.0.0.1:5173/src/main.tsx"');
  });

  it("serves the SPA shell, static assets, bootstrap API, and snapshot API", async () => {
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
      assetRoot: fixtureAssetRoot,
      loadSnapshot: async () => snapshot,
    });
    servers.push(server);

    const overview = await fetch(`${server.url}/overview`);
    const missingRoute = await fetch(`${server.url}/not-a-real-route`);
    const asset = await fetch(`${server.url}/assets/app.js`);
    const bootstrap = await fetch(`${server.url}/api/console/bootstrap`);
    const snapshotResponse = await fetch(`${server.url}/api/snapshot`);

    expect(overview.status).toBe(200);
    expect(await overview.text()).toContain('<div id="root"></div>');
    expect(missingRoute.status).toBe(200);
    expect(await missingRoute.text()).toContain('<script type="module" src="/assets/app.js"></script>');
    expect(asset.status).toBe(200);
    expect(await asset.text()).toContain("phoenix web fixture");
    expect(bootstrap.status).toBe(200);
    expect(await bootstrap.json()).toMatchObject({
      posture: {
        bindingMode: "loopback-only",
        requestSource: "loopback",
        manualActionsAvailable: true,
      },
      actions: {
        directMutations: true,
        watchLifecycle: "web-serve-process",
        defaultHookEvent: "gateway:startup",
        notificationOverridesSupported: true,
        watchExclusiveWhileRunning: true,
      },
      routes: {
        defaultView: "overview",
        views: ["overview", "setup", "activity", "archives", "configuration"],
      },
      ui: {
        defaultLocale: "en",
        supportedLocales: ["en", "zh-CN"],
        defaultTheme: "dark",
        supportedThemes: ["dark", "light"],
      },
    });
    expect(snapshotResponse.status).toBe(200);
    expect(await snapshotResponse.json()).toMatchObject({
      schemaVersion: 1,
      archives: { archives: [{ fileName: "backup.tar.gz" }] },
    });
  });

  it("returns a snapshot API error without breaking the SPA shell", async () => {
    const server = await startPhoenixWebConsole({
      host: "127.0.0.1",
      port: 0,
      assetRoot: fixtureAssetRoot,
      loadSnapshot: async () => {
        throw new Error("snapshot load failed");
      },
    });
    servers.push(server);

    const shell = await fetch(`${server.url}/configuration`);
    const snapshotResponse = await fetch(`${server.url}/api/snapshot`);

    expect(shell.status).toBe(200);
    expect(await shell.text()).toContain('<div id="root"></div>');
    expect(snapshotResponse.status).toBe(500);
    expect(await snapshotResponse.json()).toMatchObject({
      ok: false,
      error: "Error: snapshot load failed",
    });
  });

  it("starts manual browser actions through the narrow action API", async () => {
    let state = buildActionState();
    const actionController: PhoenixWebActionController = {
      getState: async () => state,
      start: async (action) => {
        state = buildActionState({
          ...state,
          runningMutation: {
            id: "run-1",
            action,
            startedAt: "2026-03-10T12:00:00.000Z",
          },
        });
        return { ok: true, state };
      },
      getActionMetadata: () => ({
        directMutations: true,
        watchLifecycle: "web-serve-process",
        defaultHookEvent: "gateway:startup",
        notificationOverridesSupported: true,
        watchExclusiveWhileRunning: true,
        context: {
          openclawBin: "openclaw",
          outputDir: "/tmp/openclaw-backups",
          retain: 2,
        },
      }),
    };
    const server = await startPhoenixWebConsole({
      host: "127.0.0.1",
      port: 0,
      assetRoot: fixtureAssetRoot,
      actionController,
      loadSnapshot: async () => buildSnapshot(),
    });
    servers.push(server);

    const overview = await fetch(`${server.url}/overview`);
    const startAction = await fetch(`${server.url}/api/actions/backup-now`, {
      method: "POST",
      headers: {
        origin: server.url,
        [PHOENIX_WEB_MANUAL_ACTION_HEADER]: "backup-now",
      },
    });
    const actionState = await fetch(`${server.url}/api/actions/state`);

    expect(overview.status).toBe(200);
    expect(await overview.text()).toContain('<div id="root"></div>');
    expect(startAction.status).toBe(202);
    expect(await startAction.json()).toMatchObject({
      ok: true,
      state: { runningMutation: { action: "backup-now" } },
    });
    expect(actionState.status).toBe(200);
    expect(await actionState.json()).toMatchObject({
      runningMutation: { action: "backup-now" },
      watch: { status: "stopped" },
    });
  });

  it("starts watch and passes JSON payloads through the expanded action API", async () => {
    let state = buildActionState();
    const received: Array<{ action: string; payload?: unknown }> = [];
    const actionController: PhoenixWebActionController = {
      getState: async () => state,
      start: async (action, payload) => {
        received.push({ action, payload });
        state = buildActionState({
          watch: action === "watch-start"
            ? {
                status: "running",
                startedAt: "2026-03-10T12:00:00.000Z",
                selfHeal: true,
              }
            : { status: "stopped" },
          lastCompleted: {
            id: "done-1",
            action,
            startedAt: "2026-03-10T12:00:00.000Z",
            finishedAt: "2026-03-10T12:00:01.000Z",
            status: "ok",
            summary: `${action} completed`,
          },
        });
        return { ok: true, state };
      },
      getActionMetadata: () => ({
        directMutations: true,
        watchLifecycle: "web-serve-process",
        defaultHookEvent: "gateway:startup",
        notificationOverridesSupported: true,
        watchExclusiveWhileRunning: true,
        context: {
          openclawBin: "openclaw",
          outputDir: "/tmp/openclaw-backups",
          retain: 2,
        },
      }),
    };
    const server = await startPhoenixWebConsole({
      host: "127.0.0.1",
      port: 0,
      assetRoot: fixtureAssetRoot,
      actionController,
      loadSnapshot: async () => buildSnapshot(),
    });
    servers.push(server);

    const startWatch = await fetch(`${server.url}/api/actions/watch/start`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: server.url,
        [PHOENIX_WEB_MANUAL_ACTION_HEADER]: "watch-start",
      },
      body: JSON.stringify({
        selfHeal: true,
        notification: {
          enabled: true,
          policy: "all",
          target: { to: "ops@example.com" },
        },
      }),
    });

    expect(startWatch.status).toBe(202);
    expect(await startWatch.json()).toMatchObject({
      ok: true,
      state: {
        watch: { status: "running", selfHeal: true },
        lastCompleted: { action: "watch-start" },
      },
    });
    expect(received).toEqual([
      {
        action: "watch-start",
        payload: {
          selfHeal: true,
          notification: {
            enabled: true,
            policy: "all",
            target: { to: "ops@example.com" },
          },
        },
      },
    ]);
  });

  it("rejects direct action posts that skip the guarded browser mutation contract", async () => {
    const actionController: PhoenixWebActionController = {
      getState: async () => buildActionState(),
      start: async () => ({ ok: true, state: buildActionState() }),
      getActionMetadata: () => ({
        directMutations: true,
        watchLifecycle: "web-serve-process",
        defaultHookEvent: "gateway:startup",
        notificationOverridesSupported: true,
        watchExclusiveWhileRunning: true,
        context: {
          openclawBin: "openclaw",
          outputDir: "/tmp/openclaw-backups",
          retain: 2,
        },
      }),
    };
    const server = await startPhoenixWebConsole({
      host: "127.0.0.1",
      port: 0,
      assetRoot: fixtureAssetRoot,
      actionController,
      loadSnapshot: async () => buildSnapshot(),
    });
    servers.push(server);

    const missingHeader = await fetch(`${server.url}/api/actions/backup-now`, { method: "POST" });
    const badOrigin = await fetch(`${server.url}/api/actions/health-check-now`, {
      method: "POST",
      headers: {
        origin: "http://evil.example",
        [PHOENIX_WEB_MANUAL_ACTION_HEADER]: "health-check-now",
      },
    });

    expect(missingHeader.status).toBe(403);
    expect(await missingHeader.json()).toMatchObject({
      ok: false,
      error: expect.stringContaining(PHOENIX_WEB_MANUAL_ACTION_HEADER),
    });
    expect(badOrigin.status).toBe(403);
    expect(await badOrigin.json()).toMatchObject({
      ok: false,
      error: expect.stringContaining("Origin mismatch"),
    });
  });

  it("returns controller conflicts for watch-exclusive routes", async () => {
    const actionController: PhoenixWebActionController = {
      getState: async () => buildActionState({
        watch: { status: "running", startedAt: "2026-03-10T12:00:00.000Z", selfHeal: true },
        capabilities: {
          "backup-now": { enabled: false, reason: "Watch owns the runtime." },
          "health-check-now": { enabled: false, reason: "Watch owns the runtime." },
          "watch-start": { enabled: false, reason: "Watch owns the runtime." },
          "watch-stop": { enabled: true },
          "hook-install": { enabled: false, reason: "Watch owns the runtime." },
          "hook-remove": { enabled: false, reason: "Watch owns the runtime." },
          "hook-run": { enabled: false, reason: "Watch owns the runtime." },
        },
      }),
      start: async () => ({
        ok: false,
        status: 409,
        error: "Watch owns the runtime.",
        state: buildActionState({
          watch: { status: "running", startedAt: "2026-03-10T12:00:00.000Z", selfHeal: true },
          capabilities: {
            "backup-now": { enabled: false, reason: "Watch owns the runtime." },
            "health-check-now": { enabled: false, reason: "Watch owns the runtime." },
            "watch-start": { enabled: false, reason: "Watch owns the runtime." },
            "watch-stop": { enabled: true },
            "hook-install": { enabled: false, reason: "Watch owns the runtime." },
            "hook-remove": { enabled: false, reason: "Watch owns the runtime." },
            "hook-run": { enabled: false, reason: "Watch owns the runtime." },
          },
        }),
      }),
      getActionMetadata: () => ({
        directMutations: true,
        watchLifecycle: "web-serve-process",
        defaultHookEvent: "gateway:startup",
        notificationOverridesSupported: true,
        watchExclusiveWhileRunning: true,
        context: {
          openclawBin: "openclaw",
          outputDir: "/tmp/openclaw-backups",
          retain: 2,
        },
      }),
    };
    const server = await startPhoenixWebConsole({
      host: "127.0.0.1",
      port: 0,
      assetRoot: fixtureAssetRoot,
      actionController,
      loadSnapshot: async () => buildSnapshot(),
    });
    servers.push(server);

    const rejected = await fetch(`${server.url}/api/actions/hook/run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: server.url,
        [PHOENIX_WEB_MANUAL_ACTION_HEADER]: "hook-run",
      },
      body: JSON.stringify({}),
    });

    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({
      ok: false,
      error: "Watch owns the runtime.",
      state: {
        watch: { status: "running" },
      },
    });
  });
});

describe("posture and guard evaluation", () => {
  it("derives loopback and remote posture correctly", () => {
    expect(derivePhoenixWebConsoleSurfacePosture({ bindHost: "127.0.0.1", defaultToLoopbackRequest: true })).toMatchObject({
      bindingMode: "loopback-only",
      requestSource: "loopback",
      manualActionsAvailable: true,
    });
    expect(derivePhoenixWebConsoleSurfacePosture({ bindHost: "0.0.0.0", remoteAddress: "192.168.1.10" })).toMatchObject({
      bindingMode: "network-exposed",
      requestSource: "remote",
      manualActionsAvailable: false,
    });
  });

  it("classifies manual action requests by loopback, header, and origin posture", () => {
    const remote = evaluatePhoenixWebManualActionRequest({
      action: "backup-now",
      bindHost: "0.0.0.0",
      method: "POST",
      remoteAddress: "192.168.1.44",
      requestHost: "phoenix.local:48789",
      requestHeader: "backup-now",
    });
    const missingHeader = evaluatePhoenixWebManualActionRequest({
      action: "backup-now",
      bindHost: "127.0.0.1",
      method: "POST",
      remoteAddress: "::ffff:127.0.0.1",
      requestHost: "127.0.0.1:48789",
    });
    const badOrigin = evaluatePhoenixWebManualActionRequest({
      action: "health-check-now",
      bindHost: "127.0.0.1",
      method: "POST",
      remoteAddress: "127.0.0.1",
      requestHost: "127.0.0.1:48789",
      origin: "http://evil.example",
      requestHeader: "health-check-now",
    });

    expect(remote).toMatchObject({ ok: false, status: 403 });
    if (remote.ok || missingHeader.ok || badOrigin.ok) {
      throw new Error("expected manual action requests to be rejected");
    }
    expect(remote.error).toBe("manualActions.unavailable");
    expect(missingHeader).toMatchObject({ ok: false, status: 403 });
    expect(missingHeader.error).toContain(PHOENIX_WEB_MANUAL_ACTION_HEADER);
    expect(badOrigin).toMatchObject({ ok: false, status: 403 });
    expect(badOrigin.error).toContain("Origin mismatch");
  });
});
