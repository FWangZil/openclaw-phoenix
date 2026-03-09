import fs from "node:fs/promises";
import path from "node:path";
import JSON5 from "json5";
import {
  AUTH_PROFILE_FILENAME,
  LEGACY_AUTH_FILENAME,
  normalizePathKey,
  resolveConfigPath,
  resolveOAuthDir,
  resolveStateDir,
  resolveUserPath,
} from "./paths.js";

const MAX_INCLUDE_DEPTH = 10;
type JsonRecord = Record<string, unknown>;

export type WatchPlan = {
  rootConfigPath: string;
  stateDir: string;
  oauthDir: string;
  targets: string[];
  warnings: string[];
};

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function listDirectIncludes(parsed: unknown): string[] {
  const out: string[] = [];
  const visit = (value: unknown) => {
    if (!value) {
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }
    const record = asRecord(value);
    if (!record) {
      return;
    }
    const includeValue = record.$include;
    if (typeof includeValue === "string") {
      out.push(includeValue);
    } else if (Array.isArray(includeValue)) {
      out.push(...includeValue.filter((entry): entry is string => typeof entry === "string"));
    }
    for (const child of Object.values(record)) {
      visit(child);
    }
  };
  visit(parsed);
  return out;
}

async function collectIncludePathsRecursive(configPath: string, parsed: unknown): Promise<string[]> {
  const visited = new Set<string>();
  const result: string[] = [];
  const walk = async (basePath: string, value: unknown, depth: number): Promise<void> => {
    if (depth > MAX_INCLUDE_DEPTH) {
      return;
    }
    for (const includePath of listDirectIncludes(value)) {
      const resolved = path.normalize(
        path.isAbsolute(includePath)
          ? includePath
          : path.resolve(path.dirname(basePath), includePath),
      );
      const key = normalizePathKey(resolved);
      if (visited.has(key)) {
        continue;
      }
      visited.add(key);
      result.push(resolved);
      const raw = await fs.readFile(resolved, "utf8").catch(() => null);
      if (!raw) {
        continue;
      }
      try {
        await walk(resolved, JSON5.parse(raw), depth + 1);
      } catch {
        // Keep watching the include even if it is currently invalid.
      }
    }
  };
  await walk(configPath, parsed, 0);
  return result;
}

function listReferencedAgentIds(parsed: unknown): string[] {
  const config = asRecord(parsed) ?? {};
  const agentConfig = asRecord(config.agents);
  const agents = Array.isArray(agentConfig?.list) ? (agentConfig.list as unknown[]) : [];
  const ids = new Set<string>();
  const defaultAgent = agents.find((entry) => asRecord(entry)?.default === true);
  const defaultId =
    typeof asRecord(defaultAgent)?.id === "string"
      ? String(asRecord(defaultAgent)?.id).trim()
      : typeof asRecord(agents[0])?.id === "string"
        ? String(asRecord(agents[0])?.id).trim()
        : "main";
  ids.add(defaultId || "main");
  for (const entry of agents) {
    const id = asRecord(entry)?.id;
    if (typeof id === "string" && id.trim()) {
      ids.add(id.trim());
    }
  }
  const bindings = Array.isArray(config.bindings) ? config.bindings : [];
  for (const entry of bindings) {
    const agentId = asRecord(entry)?.agentId;
    if (typeof agentId === "string" && agentId.trim()) {
      ids.add(agentId.trim());
    }
  }
  return [...ids];
}

function resolveAgentDir(parsed: unknown, agentId: string, stateDir: string): string {
  const agentConfig = asRecord(asRecord(parsed)?.agents);
  const agents = Array.isArray(agentConfig?.list) ? (agentConfig.list as unknown[]) : [];
  const configured = agents.find((entry) => asRecord(entry)?.id === agentId);
  const agentDir = asRecord(configured)?.agentDir;
  return typeof agentDir === "string" && agentDir.trim()
    ? resolveUserPath(agentDir)
    : path.join(stateDir, "agents", agentId, "agent");
}

async function collectAuthStorePaths(parsed: unknown, stateDir: string): Promise<string[]> {
  const targets = new Set<string>();
  const addAgentStore = (agentDir: string) => {
    targets.add(path.join(agentDir, AUTH_PROFILE_FILENAME));
    targets.add(path.join(agentDir, LEGACY_AUTH_FILENAME));
  };
  addAgentStore(path.join(stateDir, "agents", "main", "agent"));
  const agentsRoot = path.join(stateDir, "agents");
  const entries = await fs.readdir(agentsRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isDirectory()) {
      addAgentStore(path.join(agentsRoot, entry.name, "agent"));
    }
  }
  for (const agentId of listReferencedAgentIds(parsed)) {
    addAgentStore(resolveAgentDir(parsed, agentId, stateDir));
  }
  return [...targets];
}

export async function resolveWatchPlan(options: {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<WatchPlan> {
  const env = options.env ?? process.env;
  const explicitConfigPath = options.configPath ? resolveUserPath(options.configPath, env) : undefined;
  const stateDir = explicitConfigPath ? path.dirname(explicitConfigPath) : resolveStateDir(env);
  const rootConfigPath = explicitConfigPath ?? resolveConfigPath({ env, stateDir });
  const oauthDir = resolveOAuthDir(env, stateDir);
  const targets = new Set<string>([rootConfigPath, oauthDir]);
  const warnings: string[] = [];
  try {
    const rawConfig = await fs.readFile(rootConfigPath, "utf8");
    const parsed = JSON5.parse(rawConfig);
    for (const includePath of await collectIncludePathsRecursive(rootConfigPath, parsed)) {
      targets.add(includePath);
    }
    for (const authStorePath of await collectAuthStorePaths(parsed, stateDir)) {
      targets.add(authStorePath);
    }
  } catch (error) {
    warnings.push(`watch target refresh skipped config-derived paths: ${String(error)}`);
    for (const authStorePath of await collectAuthStorePaths(undefined, stateDir)) {
      targets.add(authStorePath);
    }
  }
  return {
    rootConfigPath,
    stateDir,
    oauthDir,
    targets: [...targets].map((entry) => path.resolve(entry)).toSorted((a, b) => a.localeCompare(b)),
    warnings,
  };
}