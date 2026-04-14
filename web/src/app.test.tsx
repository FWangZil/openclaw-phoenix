// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PhoenixConsoleApp } from "./app";
import type { ActionState, ConsoleBootstrap, PhoenixWebSnapshot } from "./types";

const originalFetch = globalThis.fetch;
const originalConfirm = globalThis.confirm;

function createResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
    },
    ...init,
  });
}

function createBootstrap(): ConsoleBootstrap {
  return {
    posture: {
      bindingMode: "loopback-only",
      requestSource: "loopback",
      manualActionsAvailable: true,
      manualActionsDetail: "Loopback only.",
      mutationGuardSummary: "guarded",
    },
    routes: {
      defaultView: "overview",
      views: ["overview", "setup", "activity", "archives", "configuration"],
    },
    actions: {
      directMutations: true,
      watchLifecycle: "web-serve-process",
      defaultHookEvent: "gateway:startup",
      notificationOverridesSupported: true,
      watchExclusiveWhileRunning: true,
      context: {
        configPath: "/tmp/openclaw.json",
        openclawBin: "openclaw",
        outputDir: "/tmp/openclaw-backups",
        retain: 2,
      },
    },
    ui: {
      defaultLocale: "en",
      supportedLocales: ["en", "zh-CN"],
      defaultTheme: "dark",
      supportedThemes: ["dark", "light"],
    },
  };
}

function createSnapshot(overrides: Partial<PhoenixWebSnapshot> = {}): PhoenixWebSnapshot {
  return {
    schemaVersion: 1,
    overview: {
      schemaVersion: 1,
      generatedAt: "2026-03-12T10:00:00.000Z",
      latestByOrigin: {},
      archiveCount: 0,
      ...overrides.overview,
    },
    timeline: { schemaVersion: 1, generatedAt: "2026-03-12T10:00:00.000Z", entries: [], runs: [], ...overrides.timeline },
    config: {
      schemaVersion: 1,
      generatedAt: "2026-03-12T10:00:00.000Z",
      deployment: {
        configPath: "/tmp/openclaw.json",
        stateDir: "/tmp/.openclaw",
        oauthDir: "/tmp/.openclaw/credentials",
        warnings: [],
      },
      origins: {
        watch: {
          configPath: "/tmp/openclaw.json",
          outputDir: "/tmp/openclaw-backups",
          retain: 2,
          selfHeal: false,
          notification: { enabled: false, policy: "off", targetConfigured: false },
        },
        hook: {
          configPath: "/tmp/openclaw.json",
          outputDir: "/tmp/openclaw-backups",
          retain: 2,
          installed: false,
          eventKey: "gateway:startup",
          hookDir: "/tmp/.openclaw/hooks/openclaw-phoenix-backup-rollback",
          notification: { enabled: false, policy: "off", targetConfigured: false },
        },
      },
      ...overrides.config,
    },
    archives: { schemaVersion: 1, generatedAt: "2026-03-12T10:00:00.000Z", archives: [], ...overrides.archives },
    setup: {
      schemaVersion: 1,
      generatedAt: "2026-03-12T10:00:00.000Z",
      items: [],
      backupReadiness: {
        state: "ready",
        title: "Backup-only readiness is clear",
        summary: "Ready for backup mode.",
      },
      selfHealReadiness: {
        state: "ready",
        title: "Self-heal readiness is clear",
        summary: "Ready for self-heal mode.",
      },
      commands: [],
      ...overrides.setup,
    },
    ...overrides,
  };
}

function createActionState(overrides: Partial<ActionState> = {}): ActionState {
  return {
    watch: {
      status: "stopped",
    },
    capabilities: {
      "backup-now": { enabled: true },
      "health-check-now": { enabled: true },
      "watch-start": { enabled: true },
      "watch-stop": { enabled: false, reason: "Watch is not currently running." },
      "hook-install": { enabled: true },
      "hook-remove": { enabled: false, reason: "The managed Phoenix hook is not installed." },
      "hook-run": { enabled: true },
    },
    ...overrides,
  };
}

function installFetchMock(options: {
  bootstrap?: ConsoleBootstrap;
  snapshot?: PhoenixWebSnapshot;
  actionState?: ActionState;
  onAction?: (url: string, body: unknown) => { status?: number; body: unknown };
}) {
  let actionState = options.actionState ?? createActionState();
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : new URL(input.url).pathname;
    if (url === "/api/console/bootstrap") {
      return createResponse(options.bootstrap ?? createBootstrap());
    }
    if (url === "/api/snapshot") {
      return createResponse(options.snapshot ?? createSnapshot());
    }
    if (url === "/api/actions/state") {
      return createResponse(actionState);
    }
    if (url.startsWith("/api/actions/")) {
      const parsedBody = init?.body ? JSON.parse(String(init.body)) : undefined;
      const result = options.onAction?.(url, parsedBody) ?? { body: { ok: true, state: actionState } };
      if (result.body && typeof result.body === "object" && "state" in (result.body as Record<string, unknown>)) {
        actionState = (result.body as { state: ActionState }).state;
      }
      return createResponse(result.body, { status: result.status ?? 202 });
    }
    throw new Error(`unexpected url: ${url}`);
  });
  globalThis.fetch = fetchMock as typeof fetch;
  return fetchMock;
}

describe("PhoenixConsoleApp", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState({}, "", "/");
    globalThis.confirm = vi.fn(() => true);
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
    globalThis.confirm = originalConfirm;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders overview and restores locale/theme preferences from localStorage", async () => {
    window.localStorage.setItem("phoenix-console-locale", "zh-CN");
    window.localStorage.setItem("phoenix-console-theme", "light");
    installFetchMock({});

    render(<PhoenixConsoleApp />);

    await waitFor(() => expect(screen.getByRole("button", { name: "立即备份" })).toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "OpenClaw Phoenix 控制台" })).toBeInTheDocument();
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(screen.getByRole("button", { name: "立即健康检查" })).toBeInTheDocument();
  });

  it("switches theme and persists the new preference", async () => {
    installFetchMock({});

    render(<PhoenixConsoleApp />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Light" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Light" }));

    expect(window.localStorage.getItem("phoenix-console-theme")).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("polls action state after backup-now and refreshes the latest summary when the action completes", async () => {
    const originalSetInterval = window.setInterval.bind(window);
    vi.spyOn(window, "setInterval").mockImplementation(((handler: TimerHandler, _timeout?: number, ...args: unknown[]) =>
      originalSetInterval(handler, 10, ...args)) as typeof window.setInterval);
    const runningState = createActionState({
      runningMutation: {
        id: "mutation-1",
        action: "backup-now",
        startedAt: "2026-03-12T10:05:00.000Z",
      },
      capabilities: {
        "backup-now": { enabled: false, reason: "Phoenix is already running backup-now. Wait for that action to finish before starting another one." },
        "health-check-now": { enabled: false, reason: "Phoenix is already running backup-now. Wait for that action to finish before starting another one." },
        "watch-start": { enabled: false, reason: "Phoenix is already running backup-now. Wait for that action to finish before starting another one." },
        "watch-stop": { enabled: false, reason: "Phoenix is already running backup-now. Wait for that action to finish before starting another one." },
        "hook-install": { enabled: false, reason: "Phoenix is already running backup-now. Wait for that action to finish before starting another one." },
        "hook-remove": { enabled: false, reason: "Phoenix is already running backup-now. Wait for that action to finish before starting another one." },
        "hook-run": { enabled: false, reason: "Phoenix is already running backup-now. Wait for that action to finish before starting another one." },
      },
    });
    const completedState = createActionState({
      lastCompleted: {
        id: "done-1",
        action: "backup-now",
        startedAt: "2026-03-12T10:05:00.000Z",
        finishedAt: "2026-03-12T10:05:05.000Z",
        status: "ok",
        summary: "Manual backup created 2026-03-12T02-52-23.741Z-openclaw-backup.tar.gz.",
      },
    });
    let actionState: ActionState = createActionState();
    let snapshot = createSnapshot();
    let polledCompletion = false;

    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : new URL(input.url).pathname;
      if (url === "/api/console/bootstrap") {
        return createResponse(createBootstrap());
      }
      if (url === "/api/snapshot") {
        return createResponse(snapshot);
      }
      if (url === "/api/actions/state") {
        if (actionState.runningMutation && !polledCompletion) {
          polledCompletion = true;
          actionState = completedState;
          snapshot = createSnapshot({
            overview: {
              schemaVersion: 1,
              generatedAt: "2026-03-12T10:05:05.000Z",
              latestAction: {
                id: "done-1",
                origin: "manual",
                operation: "backup-cycle",
                status: "ok",
                summary: "Manual backup created 2026-03-12T02-52-23.741Z-openclaw-backup.tar.gz.",
                finishedAt: "2026-03-12T10:05:05.000Z",
              },
              latestByOrigin: {},
              archiveCount: 1,
            },
          });
        }
        return createResponse(actionState);
      }
      if (url === "/api/actions/backup-now") {
        actionState = runningState;
        return createResponse({ ok: true, state: runningState }, { status: 202 });
      }
      throw new Error(`unexpected url: ${url}`);
    }) as typeof fetch;

    render(<PhoenixConsoleApp />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Backup now" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Backup now" }));

    await waitFor(() => expect(screen.getByText(/Action running: backup-now/)).toBeInTheDocument());

    await waitFor(() => {
      expect(screen.getByText("Manual backup created 2026-03-12T02-52-23.741Z-openclaw-backup.tar.gz.")).toBeInTheDocument();
    }, { timeout: 2_000 });
  });

  it("renders mode controls and sends watch-start payloads from the configuration page", async () => {
    const fetchMock = installFetchMock({
      onAction: (url, body) => {
        if (url === "/api/actions/watch/start") {
          return {
            body: {
              ok: true,
              state: createActionState({
                watch: {
                  status: "running",
                  startedAt: "2026-03-12T10:05:00.000Z",
                  selfHeal: true,
                  notification: {
                    enabled: true,
                    policy: "all",
                    target: { to: "ops@example.com" },
                  },
                },
                capabilities: {
                  ...createActionState().capabilities,
                  "backup-now": { enabled: false, reason: "Watch owns the runtime." },
                  "health-check-now": { enabled: false, reason: "Watch owns the runtime." },
                  "watch-start": { enabled: false, reason: "Watch owns the runtime." },
                  "watch-stop": { enabled: true },
                  "hook-install": { enabled: false, reason: "Watch owns the runtime." },
                  "hook-remove": { enabled: false, reason: "Watch owns the runtime." },
                  "hook-run": { enabled: false, reason: "Watch owns the runtime." },
                },
              }),
            },
          };
        }
        return { body: { ok: true, state: createActionState() } };
      },
    });

    render(<PhoenixConsoleApp />);

    await waitFor(() => expect(screen.getByRole("link", { name: "Configuration" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("link", { name: "Configuration" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Mode controls" })).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText("Watch self-heal"));
    fireEvent.change(screen.getByLabelText("Watch notify mode"), { target: { value: "all" } });
    fireEvent.change(screen.getByLabelText("Watch notify target"), { target: { value: "ops@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Start watch" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/actions/watch/start",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            selfHeal: true,
            notification: {
              enabled: true,
              policy: "all",
              target: { to: "ops@example.com" },
            },
          }),
        }),
      );
    });
  });

  it("disables overview backup and health actions while watch owns the runtime", async () => {
    installFetchMock({
      actionState: createActionState({
        watch: {
          status: "running",
          startedAt: "2026-03-12T10:05:00.000Z",
          selfHeal: true,
        },
        capabilities: {
          ...createActionState().capabilities,
          "backup-now": { enabled: false, reason: "Watch owns the runtime." },
          "health-check-now": { enabled: false, reason: "Watch owns the runtime." },
          "watch-start": { enabled: false, reason: "Watch owns the runtime." },
          "watch-stop": { enabled: true },
          "hook-install": { enabled: false, reason: "Watch owns the runtime." },
          "hook-remove": { enabled: false, reason: "Watch owns the runtime." },
          "hook-run": { enabled: false, reason: "Watch owns the runtime." },
        },
      }),
    });

    render(<PhoenixConsoleApp />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Backup now" })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Backup now" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Health check now" })).toBeDisabled();
    expect(screen.getByText("Watch owns the runtime.")).toBeInTheDocument();
  });

  it("confirms stop-watch and hook-install mutations before posting, and sends hook payloads", async () => {
    const confirmMock = vi.fn(() => false).mockReturnValueOnce(false).mockReturnValueOnce(true).mockReturnValueOnce(true);
    globalThis.confirm = confirmMock;
    const fetchMock = installFetchMock({
      snapshot: createSnapshot({
        config: {
          schemaVersion: 1,
          generatedAt: "2026-03-12T10:00:00.000Z",
          deployment: {
            configPath: "/tmp/openclaw.json",
            stateDir: "/tmp/.openclaw",
            oauthDir: "/tmp/.openclaw/credentials",
            warnings: [],
          },
          origins: {
            watch: {
              configPath: "/tmp/openclaw.json",
              outputDir: "/tmp/openclaw-backups",
              retain: 2,
              selfHeal: true,
              notification: { enabled: true, policy: "all", targetConfigured: true },
            },
            hook: {
              configPath: "/tmp/openclaw.json",
              outputDir: "/tmp/openclaw-backups",
              retain: 2,
              installed: true,
              eventKey: "gateway:startup",
              hookDir: "/tmp/.openclaw/hooks/openclaw-phoenix-backup-rollback",
              notification: { enabled: true, policy: "all", targetConfigured: true },
            },
          },
        },
      }),
      actionState: createActionState({
        watch: {
          status: "running",
          startedAt: "2026-03-12T10:05:00.000Z",
          selfHeal: true,
        },
        capabilities: {
          ...createActionState().capabilities,
          "backup-now": { enabled: false, reason: "Watch owns the runtime." },
          "health-check-now": { enabled: false, reason: "Watch owns the runtime." },
          "watch-start": { enabled: false, reason: "Watch owns the runtime." },
          "watch-stop": { enabled: true },
          "hook-install": { enabled: false, reason: "Watch owns the runtime." },
          "hook-remove": { enabled: false, reason: "Watch owns the runtime." },
          "hook-run": { enabled: false, reason: "Watch owns the runtime." },
        },
      }),
      onAction: (url) => {
        if (url === "/api/actions/watch/stop") {
          return { body: { ok: true, state: createActionState() } };
        }
        if (url === "/api/actions/hook/install") {
          return {
            body: {
              ok: true,
              state: createActionState({
                lastCompleted: {
                  id: "hook-install",
                  action: "hook-install",
                  startedAt: "2026-03-12T10:06:00.000Z",
                  finishedAt: "2026-03-12T10:06:01.000Z",
                  status: "ok",
                  summary: "Installed Phoenix hook on gateway:startup.",
                },
              }),
            },
          };
        }
        return { body: { ok: true, state: createActionState() } };
      },
    });

    render(<PhoenixConsoleApp />);

    await waitFor(() => expect(screen.getByRole("link", { name: "Configuration" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("link", { name: "Configuration" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop watch" })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Stop watch" }));
    expect(confirmMock).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/actions/watch/stop",
      expect.objectContaining({ method: "POST" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Stop watch" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/actions/watch/stop",
        expect.objectContaining({ method: "POST" }),
      );
    });

    fireEvent.change(screen.getByLabelText("Hook event"), { target: { value: "gateway:startup" } });
    fireEvent.change(screen.getByLabelText("Hook notify mode"), { target: { value: "all" } });
    fireEvent.change(screen.getByLabelText("Hook notify target"), { target: { value: "ops@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Install hook" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/actions/hook/install",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            eventKey: "gateway:startup",
            notification: {
              enabled: true,
              policy: "all",
              target: { to: "ops@example.com" },
            },
          }),
        }),
      );
    });
  });
});
