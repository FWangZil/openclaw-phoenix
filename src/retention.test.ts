import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pruneBackupArchives } from "./retention.js";

const tempDirs: string[] = [];

async function makeArchive(dir: string, name: string, mtimeMs: number) {
  const archivePath = path.join(dir, name);
  await fs.writeFile(archivePath, name, "utf8");
  await fs.utimes(archivePath, new Date(mtimeMs), new Date(mtimeMs));
  return archivePath;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((entry) => fs.rm(entry, { recursive: true, force: true })));
});

describe("pruneBackupArchives", () => {
  it("keeps the newest matching archives and deletes older ones", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "phoenix-retention-"));
    tempDirs.push(dir);
    const oldest = await makeArchive(dir, "2026-03-07T00-00-00.000Z-openclaw-backup.tar.gz", 1_000);
    const middle = await makeArchive(dir, "2026-03-08T00-00-00.000Z-openclaw-backup.tar.gz", 2_000);
    const newest = await makeArchive(dir, "2026-03-09T00-00-00.000Z-openclaw-backup.tar.gz", 3_000);
    const unrelated = path.join(dir, "notes.txt");
    await fs.writeFile(unrelated, "keep me", "utf8");

    const result = await pruneBackupArchives({ directory: dir, retain: 2 });

    expect(result.kept).toEqual([newest, middle]);
    expect(result.deleted).toEqual([oldest]);
    await expect(fs.access(newest)).resolves.toBeUndefined();
    await expect(fs.access(middle)).resolves.toBeUndefined();
    await expect(fs.access(oldest)).rejects.toBeTruthy();
    await expect(fs.access(unrelated)).resolves.toBeUndefined();
  });
});