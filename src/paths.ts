import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LEGACY_STATE_DIRS = [".clawdbot", ".moldbot", ".moltbot"] as const;
const LEGACY_CONFIG_FILES = ["clawdbot.json", "moldbot.json", "moltbot.json"] as const;

export const DEFAULT_OPENCLAW_BIN = "openclaw";
export const DEFAULT_OUTPUT_DIR = "~/openclaw-backups";
export const OPENCLAW_CONFIG_FILENAME = "openclaw.json";
export const OAUTH_DIRNAME = "credentials";
export const AUTH_PROFILE_FILENAME = "auth-profiles.json";
export const LEGACY_AUTH_FILENAME = "auth.json";

const WINDOWS_ABSOLUTE_PATH_RE = /^[A-Za-z]:\//;

export function resolveHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOME?.trim() || os.homedir();
}

export function resolveUserPath(rawPath: string, env: NodeJS.ProcessEnv = process.env): string {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed === "~") {
    return resolveHomeDir(env);
  }
  if (trimmed.startsWith("~/")) {
    return path.resolve(resolveHomeDir(env), trimmed.slice(2));
  }
  return path.resolve(trimmed);
}

export function resolveStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OPENCLAW_STATE_DIR?.trim() || env.CLAWDBOT_STATE_DIR?.trim();
  if (override) {
    return resolveUserPath(override, env);
  }
  const homeDir = resolveHomeDir(env);
  const nextDir = path.join(homeDir, ".openclaw");
  if (fs.existsSync(nextDir)) {
    return nextDir;
  }
  for (const legacyDir of LEGACY_STATE_DIRS) {
    const candidate = path.join(homeDir, legacyDir);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return nextDir;
}

export function resolveConfigPath(options: {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
} = {}): string {
  const env = options.env ?? process.env;
  const explicit = options.configPath?.trim() || env.OPENCLAW_CONFIG_PATH?.trim() || env.CLAWDBOT_CONFIG_PATH?.trim();
  if (explicit) {
    return resolveUserPath(explicit, env);
  }
  const stateDir = options.stateDir ?? resolveStateDir(env);
  const candidates = [
    path.join(stateDir, OPENCLAW_CONFIG_FILENAME),
    ...LEGACY_CONFIG_FILES.map((name) => path.join(stateDir, name)),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

export function resolveOAuthDir(
  env: NodeJS.ProcessEnv = process.env,
  stateDir: string = resolveStateDir(env),
): string {
  const override = env.OPENCLAW_OAUTH_DIR?.trim();
  return override ? resolveUserPath(override, env) : path.join(stateDir, OAUTH_DIRNAME);
}

export function resolveOutputDir(outputDir = DEFAULT_OUTPUT_DIR, env: NodeJS.ProcessEnv = process.env): string {
  return resolveUserPath(outputDir, env);
}

export function shortenHomePath(targetPath: string, env: NodeJS.ProcessEnv = process.env): string {
  const homeDir = resolveHomeDir(env);
  return targetPath === homeDir || targetPath.startsWith(`${homeDir}${path.sep}`)
    ? targetPath.replace(homeDir, "~")
    : targetPath;
}

export function encodeAbsolutePathForBackupArchive(sourcePath: string): string {
  const normalized = sourcePath.replaceAll("\\", "/");
  const windowsMatch = normalized.match(/^([A-Za-z]):\/(.*)$/);
  if (windowsMatch) {
    const drive = windowsMatch[1]?.toUpperCase() ?? "UNKNOWN";
    const rest = windowsMatch[2] ?? "";
    return path.posix.join("windows", drive, rest);
  }
  if (normalized.startsWith("/")) {
    return path.posix.join("posix", normalized.slice(1));
  }
  return path.posix.join("relative", normalized);
}

export function buildBackupArchivePath(archiveRoot: string, sourcePath: string): string {
  return path.posix.join(archiveRoot, "payload", encodeAbsolutePathForBackupArchive(sourcePath));
}

export function isCrossPlatformArchivePath(targetPath: string): boolean {
  return WINDOWS_ABSOLUTE_PATH_RE.test(targetPath.replaceAll("\\", "/")) && process.platform !== "win32";
}

export function normalizePathKey(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  return process.platform === "darwin" || process.platform === "win32"
    ? resolved.toLowerCase()
    : resolved;
}