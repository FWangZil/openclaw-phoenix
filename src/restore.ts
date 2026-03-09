import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import * as tar from "tar";
import { runOpenClawBackupVerify, type BackupVerifyResult } from "./backup.js";
import {
  buildBackupArchivePath,
  isCrossPlatformArchivePath,
  normalizePathKey,
  shortenHomePath,
} from "./paths.js";
import { resolveWatchPlan } from "./watch-plan.js";

type RestoreManifestAsset = {
  kind: string;
  sourcePath: string;
  archivePath: string;
};

type RestoreManifest = {
  schemaVersion: number;
  archiveRoot: string;
  createdAt: string;
  paths?: {
    stateDir?: string;
    configPath?: string;
    oauthDir?: string;
    workspaceDirs?: string[];
  };
  assets: RestoreManifestAsset[];
};

type ArchiveEntryDescriptor = {
  path: string;
  type: string;
};

type PlannedRestoreAsset = {
  kind: string;
  sourcePath: string;
  archivePath: string;
  destinationPath: string;
  nodeType: "file" | "directory";
};

export type RestoreArchiveResult = {
  archivePath: string;
  archiveRoot: string;
  assetCount: number;
  dryRun: boolean;
  restoredPaths: string[];
  verification: BackupVerifyResult;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeArchivePath(value: string, label: string): string {
  const normalized = path.posix.normalize(value.replaceAll("\\", "/")).replace(/\/+$/u, "");
  if (!normalized || normalized === ".") {
    throw new Error(`${label} is empty.`);
  }
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`${label} escapes the archive root: ${value}`);
  }
  if (path.posix.isAbsolute(normalized) || normalized.startsWith("//")) {
    throw new Error(`${label} must be relative: ${value}`);
  }
  return normalized;
}

function isArchivePathWithin(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function isPathWithinOrEqual(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function countArchiveSegments(entryPath: string): number {
  return entryPath.split("/").filter(Boolean).length;
}

function resolveSourcePathForHost(sourcePath: string): string {
  return isCrossPlatformArchivePath(sourcePath) ? sourcePath : path.resolve(sourcePath);
}

function relativeWithin(rootPath: string, candidatePath: string): string {
  const relative = path.relative(rootPath, candidatePath);
  if (!isPathWithinOrEqual(rootPath, candidatePath)) {
    throw new Error(`Resolved restore destination escapes target root: ${candidatePath}`);
  }
  return relative;
}

function parseManifest(raw: string): RestoreManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Backup manifest is not valid JSON: ${String(error)}`);
  }
  if (!isRecord(parsed)) {
    throw new Error("Backup manifest must be an object.");
  }
  if (parsed.schemaVersion !== 1) {
    throw new Error(`Unsupported backup manifest schemaVersion: ${String(parsed.schemaVersion)}`);
  }
  if (typeof parsed.archiveRoot !== "string" || !parsed.archiveRoot.trim()) {
    throw new Error("Backup manifest is missing archiveRoot.");
  }
  if (!Array.isArray(parsed.assets)) {
    throw new Error("Backup manifest is missing assets.");
  }
  return {
    schemaVersion: 1,
    archiveRoot: parsed.archiveRoot,
    createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "unknown",
    paths: isRecord(parsed.paths)
      ? {
          stateDir: typeof parsed.paths.stateDir === "string" ? parsed.paths.stateDir : undefined,
          configPath: typeof parsed.paths.configPath === "string" ? parsed.paths.configPath : undefined,
          oauthDir: typeof parsed.paths.oauthDir === "string" ? parsed.paths.oauthDir : undefined,
          workspaceDirs: Array.isArray(parsed.paths.workspaceDirs)
            ? parsed.paths.workspaceDirs.filter((entry): entry is string => typeof entry === "string")
            : undefined,
        }
      : undefined,
    assets: parsed.assets.map((asset, index) => {
      if (!isRecord(asset)) {
        throw new Error(`Backup manifest asset ${index + 1} must be an object.`);
      }
      if (typeof asset.sourcePath !== "string" || !asset.sourcePath.trim()) {
        throw new Error(`Backup manifest asset ${index + 1} is missing sourcePath.`);
      }
      if (typeof asset.archivePath !== "string" || !asset.archivePath.trim()) {
        throw new Error(`Backup manifest asset ${index + 1} is missing archivePath.`);
      }
      return {
        kind: typeof asset.kind === "string" ? asset.kind : "unknown",
        sourcePath: asset.sourcePath.trim(),
        archivePath: normalizeArchivePath(asset.archivePath, `Backup manifest asset ${index + 1} archivePath`),
      };
    }),
  };
}

async function listArchiveEntries(archivePath: string): Promise<ArchiveEntryDescriptor[]> {
  const entries: ArchiveEntryDescriptor[] = [];
  await tar.t({
    file: archivePath,
    onReadEntry: (entry) => {
      entries.push({
        path: normalizeArchivePath(entry.path, "Archive entry"),
        type: String(entry.type),
      });
      entry.resume();
    },
  });
  return entries;
}

async function extractArchiveSelection(options: {
  archivePath: string;
  matches: (entryPath: string) => boolean;
  strip: number;
}): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "phoenix-restore-"));
  try {
    await tar.x({
      file: options.archivePath,
      cwd: tempDir,
      strip: options.strip,
      strict: true,
      preservePaths: false,
      filter: (entryPath) => options.matches(normalizeArchivePath(entryPath, "Archive entry")),
    });
    return tempDir;
  } catch (error) {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function readManifestFromArchive(archivePath: string, archiveRoot: string): Promise<RestoreManifest> {
  const manifestEntryPath = path.posix.join(normalizeArchivePath(archiveRoot, "Backup archive root"), "manifest.json");
  const tempDir = await extractArchiveSelection({
    archivePath,
    matches: (entryPath) => entryPath === manifestEntryPath,
    strip: countArchiveSegments(path.posix.dirname(manifestEntryPath)),
  });
  try {
    const manifestRaw = await fs.readFile(path.join(tempDir, "manifest.json"), "utf8");
    return parseManifest(manifestRaw);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function resolveDestinationPath(params: {
  asset: RestoreManifestAsset;
  manifest: RestoreManifest;
  stateDir: string;
  rootConfigPath: string;
  oauthDir: string;
}): string {
  const configPath = params.manifest.paths?.configPath ? path.resolve(params.manifest.paths.configPath) : undefined;
  const oauthDir = params.manifest.paths?.oauthDir ? path.resolve(params.manifest.paths.oauthDir) : undefined;
  const stateDir = params.manifest.paths?.stateDir ? path.resolve(params.manifest.paths.stateDir) : undefined;
  const sourcePath = resolveSourcePathForHost(params.asset.sourcePath);
  if (configPath && normalizePathKey(sourcePath) === normalizePathKey(configPath)) {
    return params.rootConfigPath;
  }
  if (oauthDir && isPathWithinOrEqual(oauthDir, sourcePath)) {
    return path.join(params.oauthDir, relativeWithin(oauthDir, sourcePath));
  }
  if (stateDir && isPathWithinOrEqual(stateDir, sourcePath)) {
    return path.join(params.stateDir, relativeWithin(stateDir, sourcePath));
  }
  return sourcePath;
}

function buildRestorePlan(params: {
  manifest: RestoreManifest;
  entries: ArchiveEntryDescriptor[];
  stateDir: string;
  rootConfigPath: string;
  oauthDir: string;
}): PlannedRestoreAsset[] {
  const entryTypes = new Map(params.entries.map((entry) => [entry.path, entry.type]));
  const planned = params.manifest.assets.map((asset) => {
    if (isCrossPlatformArchivePath(asset.sourcePath)) {
      throw new Error(`Cross-platform restore path is not supported on this host: ${asset.sourcePath}`);
    }
    const sourcePath = resolveSourcePathForHost(asset.sourcePath);
    const expectedArchivePath = buildBackupArchivePath(params.manifest.archiveRoot, sourcePath);
    if (asset.archivePath !== expectedArchivePath) {
      throw new Error(
        `Manifest archive path does not match the expected backup layout for ${asset.sourcePath}: ${asset.archivePath}`,
      );
    }
    const exactType = entryTypes.get(asset.archivePath);
    const hasNested = params.entries.some(
      (entry) => entry.path !== asset.archivePath && isArchivePathWithin(entry.path, asset.archivePath),
    );
    const nodeType = exactType === "File" || exactType === "OldFile" || exactType === "ContiguousFile"
      ? "file"
      : exactType === "Directory" || hasNested
        ? "directory"
        : null;
    if (!nodeType) {
      throw new Error(`Archive payload for ${asset.sourcePath} is missing or uses an unsupported entry type.`);
    }
    return {
      kind: asset.kind,
      sourcePath,
      archivePath: asset.archivePath,
      destinationPath: resolveDestinationPath({
        asset: { ...asset, sourcePath },
        manifest: params.manifest,
        stateDir: params.stateDir,
        rootConfigPath: params.rootConfigPath,
        oauthDir: params.oauthDir,
      }),
      nodeType,
    } satisfies PlannedRestoreAsset;
  });
  const seenDestinations = new Set<string>();
  for (const asset of planned) {
    const key = normalizePathKey(asset.destinationPath);
    if (seenDestinations.has(key)) {
      throw new Error(`Restore plan has duplicate destination path: ${asset.destinationPath}`);
    }
    seenDestinations.add(key);
  }
  return planned;
}

async function ensureDirectorySafe(directoryPath: string, boundaryRoot = path.parse(path.resolve(directoryPath)).root): Promise<void> {
  const resolved = path.resolve(directoryPath);
  const resolvedBoundaryRoot = path.resolve(boundaryRoot);
  if (!isPathWithinOrEqual(resolvedBoundaryRoot, resolved)) {
    throw new Error(`Restore path escapes its boundary root: ${resolved}`);
  }
  const boundaryStat = await fs.lstat(resolvedBoundaryRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (boundaryStat?.isSymbolicLink()) {
    throw new Error(`Refusing to restore through symlinked path: ${resolvedBoundaryRoot}`);
  }
  if (boundaryStat && !boundaryStat.isDirectory()) {
    throw new Error(`Restore path collides with a non-directory: ${resolvedBoundaryRoot}`);
  }
  if (!boundaryStat) {
    await fs.mkdir(resolvedBoundaryRoot, { recursive: true });
  }
  let current = resolvedBoundaryRoot;
  for (const segment of path.relative(resolvedBoundaryRoot, resolved).split(path.sep).filter(Boolean)) {
    const next = path.join(current, segment);
    const stat = await fs.lstat(next).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return null;
      }
      throw error;
    });
    if (!stat) {
      await fs.mkdir(next);
      current = next;
      continue;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing to restore through symlinked path: ${next}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`Restore path collides with a non-directory: ${next}`);
    }
    current = next;
  }
}

async function copyStagedFile(sourcePath: string, destinationPath: string, boundaryRoot: string): Promise<void> {
  await ensureDirectorySafe(path.dirname(destinationPath), boundaryRoot);
  const existing = await fs.lstat(destinationPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (existing?.isSymbolicLink()) {
    throw new Error(`Refusing to overwrite symlinked restore target: ${destinationPath}`);
  }
  if (existing && !existing.isFile()) {
    throw new Error(`Restore target is not a file: ${destinationPath}`);
  }
  const sourceStat = await fs.lstat(sourcePath);
  if (!sourceStat.isFile() || sourceStat.nlink > 1) {
    throw new Error(`Unsupported staged restore file: ${sourcePath}`);
  }
  await fs.copyFile(sourcePath, destinationPath);
  await fs.chmod(destinationPath, sourceStat.mode & 0o777).catch(() => undefined);
}

async function copyStagedTree(sourceDir: string, destinationDir: string, boundaryRoot: string): Promise<void> {
  await ensureDirectorySafe(destinationDir, boundaryRoot);
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const destinationPath = path.join(destinationDir, entry.name);
    const stat = await fs.lstat(sourcePath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Unsupported staged restore entry: ${sourcePath}`);
    }
    if (stat.isDirectory()) {
      await copyStagedTree(sourcePath, destinationPath, boundaryRoot);
      continue;
    }
    if (!stat.isFile() || stat.nlink > 1) {
      throw new Error(`Unsupported staged restore entry: ${sourcePath}`);
    }
    await copyStagedFile(sourcePath, destinationPath, boundaryRoot);
  }
}

async function promptForConfirmation(prompt: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Restore needs interactive confirmation. Re-run with --yes or use --dry-run.");
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${prompt} [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

export async function restoreBackupArchive(options: {
  archivePath: string;
  configPath?: string;
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv;
  openclawBin: string;
  yes?: boolean;
  log?: (message: string) => void;
  error?: (message: string) => void;
  confirm?: (prompt: string) => Promise<boolean>;
}): Promise<RestoreArchiveResult> {
  const env = options.env ?? process.env;
  const log = options.log ?? console.log;
  const error = options.error ?? console.error;
  const archivePath = path.resolve(options.archivePath);
  const effectiveEnv = {
    ...env,
    ...(options.configPath ? { OPENCLAW_CONFIG_PATH: options.configPath } : {}),
  };
  const verification = await runOpenClawBackupVerify({
    openclawBin: options.openclawBin,
    archivePath,
    env: effectiveEnv,
  });
  const manifest = await readManifestFromArchive(archivePath, verification.archiveRoot);
  if (manifest.archiveRoot !== verification.archiveRoot) {
    throw new Error(`Backup manifest archive root mismatch: ${manifest.archiveRoot} !== ${verification.archiveRoot}`);
  }
  const watchPlan = await resolveWatchPlan({ configPath: options.configPath, env: effectiveEnv });
  for (const warning of watchPlan.warnings) {
    error(warning);
  }
  const archiveEntries = await listArchiveEntries(archivePath);
  const plan = buildRestorePlan({
    manifest,
    entries: archiveEntries,
    stateDir: watchPlan.stateDir,
    rootConfigPath: watchPlan.rootConfigPath,
    oauthDir: watchPlan.oauthDir,
  });

  log(`verified archive: ${shortenHomePath(archivePath, effectiveEnv)}`);
  for (const asset of plan) {
    log(
      `${options.dryRun ? "would restore" : "restore target"}: ${shortenHomePath(asset.destinationPath, effectiveEnv)} (${asset.kind})`,
    );
  }

  if (options.dryRun) {
    return {
      archivePath,
      archiveRoot: verification.archiveRoot,
      assetCount: plan.length,
      dryRun: true,
      restoredPaths: [],
      verification,
    };
  }

  if (!options.yes) {
    const confirmed = await (options.confirm ?? promptForConfirmation)(
      `Restore ${plan.length} archive path${plan.length === 1 ? "" : "s"} into the current OpenClaw deployment?`,
    );
    if (!confirmed) {
      throw new Error("Restore cancelled.");
    }
  }

  const restoredPaths: string[] = [];
  for (const asset of plan.toSorted((left, right) => right.archivePath.length - left.archivePath.length)) {
    const boundaryRoot = path.dirname(asset.destinationPath);
    const stageDir = await extractArchiveSelection({
      archivePath,
      matches: (entryPath) => isArchivePathWithin(entryPath, asset.archivePath),
      strip:
        asset.nodeType === "file"
          ? countArchiveSegments(path.posix.dirname(asset.archivePath))
          : countArchiveSegments(asset.archivePath),
    });
    try {
      if (asset.nodeType === "file") {
        await copyStagedFile(path.join(stageDir, path.posix.basename(asset.archivePath)), asset.destinationPath, boundaryRoot);
      } else {
        await copyStagedTree(stageDir, asset.destinationPath, boundaryRoot);
        await ensureDirectorySafe(asset.destinationPath, boundaryRoot);
      }
      restoredPaths.push(asset.destinationPath);
    } finally {
      await fs.rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  log(`restored ${restoredPaths.length} archive path${restoredPaths.length === 1 ? "" : "s"}`);
  return {
    archivePath,
    archiveRoot: verification.archiveRoot,
    assetCount: plan.length,
    dryRun: false,
    restoredPaths,
    verification,
  };
}