import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recordPhoenixRecoveryAction, buildPhoenixWebSnapshot } from "./web-contract.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("buildPhoenixWebSnapshot setup", () => {
  it("marks backup setup blocked when the config file is missing but the output dir can be auto-created", async () => {
    const homeDir = await makeTempDir("phoenix-web-setup-blocked-");
    const stateDir = path.join(homeDir, ".openclaw");
    const configPath = path.join(stateDir, "openclaw.json");
    const outputDir = path.join(homeDir, "archives");
    await fs.mkdir(stateDir, { recursive: true });

    const snapshot = await buildPhoenixWebSnapshot({
      configPath,
      env: { ...process.env, HOME: homeDir },
      outputDir,
      timelineLimit: 5,
    });

    expect(snapshot.setup.backupReadiness.state).toBe("blocked");
    expect(snapshot.setup.selfHealReadiness.state).toBe("blocked");
    expect(snapshot.setup.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "config-path", severity: "blocker", priority: "required" }),
      expect.objectContaining({ id: "output-dir", severity: "info", priority: "required" }),
    ]));
    expect(snapshot.setup.commands[0]?.command).toContain("--notify off");
  });

  it("reports ready backup and self-heal setup when watch self-heal plus notifications are configured", async () => {
    const homeDir = await makeTempDir("phoenix-web-setup-ready-");
    const stateDir = path.join(homeDir, ".openclaw");
    const configPath = path.join(stateDir, "openclaw.json");
    const oauthDir = path.join(stateDir, "credentials");
    const outputDir = path.join(homeDir, "archives");
    const archivePath = path.join(outputDir, "2026-03-10T12-00-00.000Z-openclaw-backup.tar.gz");
    await fs.mkdir(oauthDir, { recursive: true });
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(configPath, JSON.stringify({ runtime: "test" }), "utf8");
    await fs.writeFile(archivePath, "archive", "utf8");

    await recordPhoenixRecoveryAction({
      origin: "watch",
      configPath,
      outputDir,
      retain: 7,
      selfHeal: true,
      notification: {
        enabled: true,
        policy: "all",
        target: { to: "alerts-room", channel: "signal", threadId: "thread-1" },
      },
      startedAt: "2026-03-10T11:59:00.000Z",
      finishedAt: "2026-03-10T12:00:00.000Z",
      result: {
        ok: true,
        backup: { attempted: true, archivePath },
        health: { healthy: true, reason: "gateway reachable" },
        knownGood: { currentArchivePath: archivePath, promotedArchivePath: archivePath },
        rollback: { needed: false, attempted: false, restored: false },
        retention: { kept: [archivePath], deleted: [] },
        notifications: [],
        notificationDelivery: { results: [] },
      },
    });

    const snapshot = await buildPhoenixWebSnapshot({
      configPath,
      env: { ...process.env, HOME: homeDir },
      outputDir,
      timelineLimit: 5,
    });

    expect(snapshot.setup.backupReadiness.state).toBe("ready");
    expect(snapshot.setup.selfHealReadiness.state).toBe("ready");
    expect(snapshot.setup.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "self-heal-mode", severity: "ok", priority: "optional" }),
      expect.objectContaining({ id: "notification-mode", severity: "ok", value: "all" }),
      expect.objectContaining({ id: "notification-target", severity: "ok", value: "alerts-room" }),
      expect.objectContaining({ id: "retain-count", severity: "ok", value: "7" }),
    ]));
    expect(snapshot.setup.commands[1]?.command).toContain("--self-heal");
    expect(snapshot.setup.commands[1]?.command).toContain("--notify-target alerts-room");
  });
});