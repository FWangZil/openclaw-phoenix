import fs from "node:fs/promises";
import path from "node:path";

export const OPENCLAW_BACKUP_ARCHIVE_SUFFIX = "-openclaw-backup.tar.gz";

export type RetentionResult = {
  kept: string[];
  deleted: string[];
};

export async function pruneBackupArchives(options: {
  directory: string;
  retain: number;
  keep?: string[];
}): Promise<RetentionResult> {
  if (!Number.isInteger(options.retain) || options.retain < 1) {
    throw new Error(`retain must be a positive integer, got ${options.retain}`);
  }
  const entries = await fs.readdir(options.directory, { withFileTypes: true }).catch(() => []);
  const archives = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(OPENCLAW_BACKUP_ARCHIVE_SUFFIX))
      .map(async (entry) => {
        const archivePath = path.join(options.directory, entry.name);
        const stat = await fs.stat(archivePath);
        return { archivePath, mtimeMs: stat.mtimeMs };
      }),
  );
  const sorted = archives.toSorted(
    (left, right) => right.mtimeMs - left.mtimeMs || right.archivePath.localeCompare(left.archivePath),
  );
  const keepSet = new Set((options.keep ?? []).map((entry) => path.resolve(entry)));
  const kept = new Set(sorted.slice(0, options.retain).map((entry) => entry.archivePath));
  for (const entry of sorted) {
    if (keepSet.has(path.resolve(entry.archivePath))) {
      kept.add(entry.archivePath);
    }
  }
  const keptList = sorted
    .map((entry) => entry.archivePath)
    .filter((archivePath) => kept.has(archivePath));
  const deleted = sorted
    .map((entry) => entry.archivePath)
    .filter((archivePath) => !kept.has(archivePath));
  await Promise.all(deleted.map((archivePath) => fs.rm(archivePath, { force: true })));
  return { kept: keptList, deleted };
}