import fs from "node:fs/promises";
import path from "node:path";

export type PhoenixRecoveryState = {
  schemaVersion: 1;
  latestKnownGoodArchivePath?: string;
  lastBackupArchivePath?: string;
  updatedAt: string;
};

export function resolvePhoenixRecoveryStatePath(outputDir: string): string {
  return path.join(outputDir, ".openclaw-phoenix-state.json");
}

export async function readPhoenixRecoveryState(outputDir: string): Promise<PhoenixRecoveryState> {
  const raw = await fs.readFile(resolvePhoenixRecoveryStatePath(outputDir), "utf8").catch(() => null);
  if (!raw) {
    return { schemaVersion: 1, updatedAt: new Date(0).toISOString() };
  }
  const parsed = JSON.parse(raw) as Partial<PhoenixRecoveryState>;
  return {
    schemaVersion: 1,
    latestKnownGoodArchivePath: typeof parsed.latestKnownGoodArchivePath === "string"
      ? parsed.latestKnownGoodArchivePath
      : undefined,
    lastBackupArchivePath: typeof parsed.lastBackupArchivePath === "string" ? parsed.lastBackupArchivePath : undefined,
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
  };
}

export async function writePhoenixRecoveryState(outputDir: string, state: PhoenixRecoveryState): Promise<void> {
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(resolvePhoenixRecoveryStatePath(outputDir), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}