import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import type { PhoenixWebSnapshot } from "./web-contract.js";
import {
  DEFAULT_PHOENIX_WEB_ACTION_METADATA,
  type PhoenixWebAction,
  type PhoenixWebActionController,
  type PhoenixWebActionMetadata,
} from "./web-actions.js";

export type PhoenixConsoleView = "overview" | "setup" | "activity" | "archives" | "configuration";

export type PhoenixWebConsoleServer = {
  url: string;
  close: () => Promise<void>;
  closed: Promise<void>;
};

export type StartPhoenixWebConsoleOptions = {
  host?: string;
  port?: number;
  assetRoot?: string;
  devAssetOrigin?: string;
  actionController?: PhoenixWebActionController;
  loadSnapshot: () => Promise<PhoenixWebSnapshot>;
};

export type PhoenixWebConsoleBindingMode = "loopback-only" | "network-exposed";
export type PhoenixWebConsoleRequestSource = "loopback" | "remote" | "unknown";
export type PhoenixWebConsoleSurfacePosture = {
  bindHost: string;
  bindingMode: PhoenixWebConsoleBindingMode;
  requestSource: PhoenixWebConsoleRequestSource;
  remoteAddress?: string;
  manualActionsAvailable: boolean;
  manualActionsDetail: string;
  mutationGuardSummary: string;
};

export type PhoenixWebConsoleBootstrap = {
  posture: Pick<
    PhoenixWebConsoleSurfacePosture,
    "bindingMode" | "requestSource" | "manualActionsAvailable" | "manualActionsDetail" | "mutationGuardSummary"
  >;
  routes: {
    defaultView: PhoenixConsoleView;
    views: PhoenixConsoleView[];
  };
  actions: PhoenixWebActionMetadata;
  ui: {
    defaultLocale: "en";
    supportedLocales: ["en", "zh-CN"];
    defaultTheme: "dark";
    supportedThemes: ["dark", "light"];
  };
};

const DEFAULT_VIEW: PhoenixConsoleView = "overview";
const VIEWS: PhoenixConsoleView[] = ["overview", "setup", "activity", "archives", "configuration"];
const DEFAULT_ASSET_ROOT = new URL("../dist/web", import.meta.url);
export const PHOENIX_WEB_ACTION_HEADER = "x-phoenix-web-action";
export const PHOENIX_WEB_MANUAL_ACTION_HEADER = PHOENIX_WEB_ACTION_HEADER;
const PHOENIX_WEB_MUTATION_GUARD_SUMMARY =
  `POST + ${PHOENIX_WEB_ACTION_HEADER} + loopback requester + same-origin Origin/Sec-Fetch-Site checks when present`;

function readHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function toHttpUrl(value: string): string {
  if (value.includes("://")) {
    return value;
  }
  const trimmed = value.trim();
  if (trimmed.includes(":") && !trimmed.startsWith("[") && trimmed.split(":").length > 2) {
    return `http://[${trimmed}]`;
  }
  return `http://${trimmed}`;
}

function normalizeHostName(value: string): string {
  try {
    return new URL(toHttpUrl(value)).hostname.toLowerCase();
  } catch {
    return value.replace(/^\[/u, "").replace(/\]$/u, "").toLowerCase();
  }
}

function isLoopbackHost(value: string): boolean {
  const normalized = normalizeHostName(value);
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

function isLoopbackRemoteAddress(value: string | undefined): boolean {
  return value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1";
}

function originForRequestHost(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return new URL(toHttpUrl(value)).origin;
  } catch {
    return undefined;
  }
}

function normalizeView(pathname: string): PhoenixConsoleView | undefined {
  const normalized = pathname === "/" ? "/overview" : pathname.replace(/\/+$/u, "") || "/overview";
  const candidate = normalized.slice(1);
  return VIEWS.find((view) => view === candidate);
}

function isAssetPath(pathname: string): boolean {
  return pathname === "/assets/app.js" || pathname === "/assets/app.css";
}

function resolveAssetPath(assetRoot: string, pathname: string): string {
  return path.join(assetRoot, pathname.replace(/^\/+/u, ""));
}

function contentTypeForPath(filePath: string): string {
  if (filePath.endsWith(".js")) {
    return "text/javascript";
  }
  if (filePath.endsWith(".css")) {
    return "text/css";
  }
  return "application/octet-stream";
}

async function ensureAssetRoot(assetRoot: string): Promise<void> {
  await fs.access(path.join(assetRoot, "assets", "app.js"));
  await fs.access(path.join(assetRoot, "assets", "app.css"));
}

function normalizeDevAssetOrigin(value: string): string {
  const origin = new URL(value).origin;
  return origin.endsWith("/") ? origin.slice(0, -1) : origin;
}

function createReactRefreshPreamble(devAssetOrigin: string): string {
  return `<script type="module">
      import RefreshRuntime from "${devAssetOrigin}/@react-refresh";
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {};
      window.$RefreshSig$ = () => (type) => type;
      window.__vite_plugin_react_preamble_installed__ = true;
    </script>`;
}

function createPhoenixWebConsoleShell(options: { devAssetOrigin?: string } = {}): string {
  const devAssetOrigin = options.devAssetOrigin ? normalizeDevAssetOrigin(options.devAssetOrigin) : undefined;
  const stylesheetHref = devAssetOrigin ? `${devAssetOrigin}/src/styles.css` : "/assets/app.css";
  const moduleScripts = devAssetOrigin
    ? [
        `${devAssetOrigin}/@vite/client`,
        `${devAssetOrigin}/src/main.tsx`,
      ]
    : ["/assets/app.js"];
  return `<!doctype html>
<html lang="en" data-theme="dark">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>OpenClaw Phoenix Console</title>
    <script>
      (() => {
        try {
          const locale = window.localStorage.getItem("phoenix-console-locale") || "en";
          const theme = window.localStorage.getItem("phoenix-console-theme") || "dark";
          document.documentElement.lang = locale;
          document.documentElement.dataset.theme = theme;
        } catch {
          document.documentElement.lang = "en";
          document.documentElement.dataset.theme = "dark";
        }
      })();
    </script>
    ${devAssetOrigin ? createReactRefreshPreamble(devAssetOrigin) : ""}
    <link rel="stylesheet" href="${stylesheetHref}" />
  </head>
  <body>
    <div id="root"></div>
    ${moduleScripts.map((source) => `<script type="module" src="${source}"></script>`).join("\n    ")}
  </body>
</html>`;
}

function writeResponse(
  response: http.ServerResponse,
  status: number,
  contentType: string,
  body: string | Buffer,
  method = "GET",
): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": `${contentType}; charset=utf-8`,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
  if (method === "HEAD") {
    response.end();
    return;
  }
  response.end(body);
}

function buildBootstrap(
  posture: PhoenixWebConsoleSurfacePosture,
  actionMetadata: PhoenixWebActionMetadata = {
    ...DEFAULT_PHOENIX_WEB_ACTION_METADATA,
    context: {
      openclawBin: "openclaw",
      outputDir: "~/openclaw-backups",
      retain: 100,
    },
  },
): PhoenixWebConsoleBootstrap {
  return {
    posture: {
      bindingMode: posture.bindingMode,
      requestSource: posture.requestSource,
      manualActionsAvailable: posture.manualActionsAvailable,
      manualActionsDetail: posture.manualActionsDetail,
      mutationGuardSummary: posture.mutationGuardSummary,
    },
    routes: {
      defaultView: DEFAULT_VIEW,
      views: VIEWS,
    },
    actions: actionMetadata,
    ui: {
      defaultLocale: "en",
      supportedLocales: ["en", "zh-CN"],
      defaultTheme: "dark",
      supportedThemes: ["dark", "light"],
    },
  };
}

export function derivePhoenixWebConsoleSurfacePosture(options: {
  bindHost?: string;
  remoteAddress?: string;
  defaultToLoopbackRequest?: boolean;
} = {}): PhoenixWebConsoleSurfacePosture {
  const bindHost = options.bindHost ?? "127.0.0.1";
  const bindingMode: PhoenixWebConsoleBindingMode = isLoopbackHost(bindHost) ? "loopback-only" : "network-exposed";
  const requestSource: PhoenixWebConsoleRequestSource = options.remoteAddress
    ? isLoopbackRemoteAddress(options.remoteAddress)
      ? "loopback"
      : "remote"
    : options.defaultToLoopbackRequest
      ? "loopback"
      : "unknown";
  const manualActionsAvailable = requestSource === "loopback";
  const manualActionsDetailKey = requestSource === "loopback"
    ? bindingMode === "loopback-only"
      ? "manualActionsDetail.loopbackOnly"
      : "manualActionsDetail.loopbackNetwork"
    : requestSource === "remote"
      ? "manualActionsDetail.remoteDisabled"
      : "manualActionsDetail.unknown";
  return {
    bindHost,
    bindingMode,
    requestSource,
    remoteAddress: options.remoteAddress,
    manualActionsAvailable,
    manualActionsDetail: manualActionsDetailKey,
    mutationGuardSummary: PHOENIX_WEB_MUTATION_GUARD_SUMMARY,
  };
}

export function evaluatePhoenixWebManualActionRequest(options: {
  action: PhoenixWebAction;
  bindHost?: string;
  method?: string;
  remoteAddress?: string;
  requestHost?: string;
  origin?: string;
  secFetchSite?: string;
  requestHeader?: string;
}):
  | { ok: true; posture: PhoenixWebConsoleSurfacePosture }
  | { ok: false; status: number; error: string; posture: PhoenixWebConsoleSurfacePosture } {
  const posture = derivePhoenixWebConsoleSurfacePosture({ bindHost: options.bindHost, remoteAddress: options.remoteAddress });
  if (options.method !== "POST") {
    return { ok: false, status: 405, error: "Method Not Allowed", posture };
  }
  if (!posture.manualActionsAvailable) {
    return { ok: false, status: 403, error: "manualActions.unavailable", posture };
  }
  if (options.requestHeader !== options.action) {
    return {
      ok: false,
      status: 403,
      error: `Manual browser actions require the Phoenix console request header (${PHOENIX_WEB_ACTION_HEADER}: ${options.action}).`,
      posture,
    };
  }
  if (options.secFetchSite && options.secFetchSite !== "same-origin" && options.secFetchSite !== "same-site" && options.secFetchSite !== "none") {
    return {
      ok: false,
      status: 403,
      error: "Cross-site browser requests cannot trigger Phoenix manual actions.",
      posture,
    };
  }
  if (options.origin) {
    const expectedOrigin = originForRequestHost(options.requestHost);
    if (!expectedOrigin) {
      return {
        ok: false,
        status: 403,
        error: "Phoenix could not validate the request origin for this manual action.",
        posture,
      };
    }
    let actualOrigin: string;
    try {
      actualOrigin = new URL(options.origin).origin;
    } catch {
      return {
        ok: false,
        status: 403,
        error: "Phoenix rejected an invalid Origin header for this manual action.",
        posture,
      };
    }
    if (actualOrigin !== expectedOrigin) {
      return {
        ok: false,
        status: 403,
        error: `Origin mismatch. Phoenix only accepts same-origin manual action requests from ${expectedOrigin}.`,
        posture,
      };
    }
  }
  return { ok: true, posture };
}

function normalizeManualAction(pathname: string): PhoenixWebAction | undefined {
  if (pathname === "/api/actions/backup-now") {
    return "backup-now";
  }
  if (pathname === "/api/actions/health-check-now") {
    return "health-check-now";
  }
  if (pathname === "/api/actions/watch/start") {
    return "watch-start";
  }
  if (pathname === "/api/actions/watch/stop") {
    return "watch-stop";
  }
  if (pathname === "/api/actions/hook/install") {
    return "hook-install";
  }
  if (pathname === "/api/actions/hook/remove") {
    return "hook-remove";
  }
  if (pathname === "/api/actions/hook/run") {
    return "hook-run";
  }
  return undefined;
}

async function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  if (chunks.length === 0) {
    return undefined;
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return undefined;
  }
  return JSON.parse(raw) as unknown;
}

export async function startPhoenixWebConsole(options: StartPhoenixWebConsoleOptions): Promise<PhoenixWebConsoleServer> {
  const bindHost = options.host ?? "127.0.0.1";
  const assetRoot = options.assetRoot ?? fileURLToPath(DEFAULT_ASSET_ROOT);
  const devAssetOrigin = options.devAssetOrigin ? normalizeDevAssetOrigin(options.devAssetOrigin) : undefined;
  if (!devAssetOrigin) {
    await ensureAssetRoot(assetRoot);
  }

  let closeResolver = () => {};
  const closed = new Promise<void>((resolve) => {
    closeResolver = resolve;
  });
  const shell = createPhoenixWebConsoleShell({ devAssetOrigin });

  const server = http.createServer(async (request, response) => {
    const method = request.method ?? "GET";
    const requestHost = readHeaderValue(request.headers.host) ?? bindHost;
    const posture = derivePhoenixWebConsoleSurfacePosture({ bindHost, remoteAddress: request.socket.remoteAddress });
    const url = new URL(request.url ?? "/", toHttpUrl(requestHost));

    if (url.pathname === "/api/console/bootstrap") {
      writeResponse(
        response,
        200,
        "application/json",
        `${JSON.stringify(buildBootstrap(posture, options.actionController?.getActionMetadata()), null, 2)}\n`,
        method,
      );
      return;
    }

    if (url.pathname === "/api/actions/state") {
      if (!options.actionController) {
        writeResponse(response, 404, "application/json", `${JSON.stringify({ ok: false, error: "Manual browser actions are unavailable." }, null, 2)}\n`, method);
        return;
      }
      if (method !== "GET" && method !== "HEAD") {
        writeResponse(response, 405, "text/plain", "Method Not Allowed", method);
        return;
      }
      writeResponse(response, 200, "application/json", `${JSON.stringify(await options.actionController.getState(), null, 2)}\n`, method);
      return;
    }

    const manualAction = normalizeManualAction(url.pathname);
    if (manualAction) {
      if (!options.actionController) {
        writeResponse(response, 404, "application/json", `${JSON.stringify({ ok: false, error: "Manual browser actions are unavailable." }, null, 2)}\n`, method);
        return;
      }
      const access = evaluatePhoenixWebManualActionRequest({
        action: manualAction,
        bindHost,
        method,
        remoteAddress: request.socket.remoteAddress,
        requestHost,
        origin: readHeaderValue(request.headers.origin),
        secFetchSite: readHeaderValue(request.headers["sec-fetch-site"]),
        requestHeader: readHeaderValue(request.headers[PHOENIX_WEB_ACTION_HEADER]),
      });
      if (!access.ok) {
        const state = await options.actionController.getState();
        writeResponse(
          response,
          access.status,
          "application/json",
          `${JSON.stringify({ ok: false, error: access.error, state }, null, 2)}\n`,
          method,
        );
        return;
      }
      let payload: unknown;
      try {
        payload = method === "POST" ? await readJsonBody(request) : undefined;
      } catch (error) {
        writeResponse(
          response,
          400,
          "application/json",
          `${JSON.stringify({ ok: false, error: `Invalid JSON body: ${String(error)}` }, null, 2)}\n`,
          method,
        );
        return;
      }
      const result = await options.actionController.start(manualAction, payload as never);
      writeResponse(response, result.ok ? 202 : (result.status ?? 409), "application/json", `${JSON.stringify(result, null, 2)}\n`, method);
      return;
    }

    if (url.pathname === "/api/snapshot") {
      try {
        const snapshot = await options.loadSnapshot();
        writeResponse(response, 200, "application/json", `${JSON.stringify(snapshot, null, 2)}\n`, method);
      } catch (error) {
        writeResponse(response, 500, "application/json", `${JSON.stringify({ ok: false, error: String(error) }, null, 2)}\n`, method);
      }
      return;
    }

    if (isAssetPath(url.pathname)) {
      try {
        const assetPath = resolveAssetPath(assetRoot, url.pathname);
        const contents = await fs.readFile(assetPath);
        writeResponse(response, 200, contentTypeForPath(assetPath), contents, method);
      } catch {
        writeResponse(response, 404, "text/plain", "Not Found", method);
      }
      return;
    }

    if (method !== "GET" && method !== "HEAD") {
      writeResponse(response, 405, "text/plain", "Method Not Allowed", method);
      return;
    }

    if (normalizeView(url.pathname) || !url.pathname.startsWith("/api/")) {
      writeResponse(response, 200, "text/html", shell, method);
      return;
    }

    writeResponse(response, 404, "text/plain", "Not Found", method);
  });

  server.on("close", () => closeResolver());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 48789, bindHost, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  return {
    url: `http://${bindHost}:${address.port}`,
    close: async () => {
      if (!server.listening) {
        return;
      }
      await options.actionController?.close?.();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
    closed,
  };
}
