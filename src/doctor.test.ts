import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatPhoenixDoctorReport, runPhoenixDoctor } from "./doctor.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function writeExecutableScript(scriptPath: string, body: string) {
  await fs.writeFile(scriptPath, body, { encoding: "utf8", mode: 0o755 });
}

async function createFakeOpenClaw(options: {
  homeDir: string;
  statusModePath: string;
  authWarningPath?: string;
}) {
  const scriptPath = path.join(options.homeDir, "fake-openclaw.mjs");
  await writeExecutableScript(
    scriptPath,
    `#!/usr/bin/env node
import fs from "node:fs/promises";
const args = process.argv.slice(2);
if (args[0] === "--help") {
  console.log("openclaw help");
  process.exit(0);
}
if (args[0] === "status" && args[1] === "--json") {
  const mode = (await fs.readFile(${JSON.stringify(options.statusModePath)}, "utf8")).trim();
  const authWarning = ${options.authWarningPath ? `(await fs.readFile(${JSON.stringify(options.authWarningPath)}, "utf8").catch(() => "")).trim()` : '""'};
  if (mode === "status-error") {
    console.error("status unavailable");
    process.exit(1);
  }
  console.log(JSON.stringify({
    gateway: {
      reachable: mode === "healthy",
      misconfigured: mode === "misconfigured",
      error: mode === "unreachable" ? "connection refused" : null,
      url: "ws://127.0.0.1:18789",
      connectLatencyMs: mode === "healthy" ? 42 : null,
      authWarning: authWarning || null,
    },
  }));
  process.exit(0);
}
console.error("unexpected args: " + args.join(" "));
process.exit(1);
`,
  );
  return scriptPath;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("runPhoenixDoctor", () => {
  it("reports ready backup and self-heal checks when the runtime prerequisites are healthy", async () => {
    const homeDir = await makeTempDir("phoenix-doctor-ready-");
    const stateDir = path.join(homeDir, ".openclaw");
    const configPath = path.join(stateDir, "openclaw.json");
    const outputDir = path.join(homeDir, "archives");
    const statusModePath = path.join(homeDir, "status-mode.txt");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(configPath, "{}\n", "utf8");
    await fs.writeFile(statusModePath, "healthy", "utf8");
    const openclawBin = await createFakeOpenClaw({ homeDir, statusModePath });

    const report = await runPhoenixDoctor({
      configPath,
      openclawBin,
      outputDir,
      env: { ...process.env, HOME: homeDir },
      notification: {
        enabled: true,
        policy: "all",
        target: { to: "room://operators", channel: "signal", threadId: "thread-1" },
      },
    });

    expect(report.ok).toBe(true);
    expect(report.backupReadiness.state).toBe("ready");
    expect(report.selfHealReadiness.state).toBe("ready");
    expect(report.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "openclaw-bin", severity: "ok" }),
      expect.objectContaining({ id: "gateway-connectivity", severity: "ok", value: "ws://127.0.0.1:18789" }),
      expect.objectContaining({ id: "gateway-auth", severity: "ok" }),
      expect.objectContaining({ id: "notification-target", severity: "ok", value: "room://operators" }),
    ]));
    expect(formatPhoenixDoctorReport(report)).toContain("Self-heal readiness: READY");
  });

  it("surfaces actionable blockers and warnings for self-heal preflight gaps", async () => {
    const homeDir = await makeTempDir("phoenix-doctor-blocked-");
    const stateDir = path.join(homeDir, ".openclaw");
    const configPath = path.join(stateDir, "openclaw.json");
    const outputDir = path.join(homeDir, "archives");
    const statusModePath = path.join(homeDir, "status-mode.txt");
    const authWarningPath = path.join(homeDir, "auth-warning.txt");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(statusModePath, "misconfigured", "utf8");
    await fs.writeFile(authWarningPath, "pair the device or refresh auth", "utf8");
    const openclawBin = await createFakeOpenClaw({ homeDir, statusModePath, authWarningPath });

    const report = await runPhoenixDoctor({
      configPath,
      openclawBin,
      outputDir,
      env: { ...process.env, HOME: homeDir },
      notification: {
        enabled: true,
        policy: "exceptional-only",
        target: { channel: "slack" },
      },
    });

    expect(report.ok).toBe(false);
    expect(report.backupReadiness.state).toBe("blocked");
    expect(report.selfHealReadiness.state).toBe("blocked");
    expect(report.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "config-path", severity: "blocker", value: configPath }),
      expect.objectContaining({ id: "output-dir", severity: "info", value: outputDir }),
      expect.objectContaining({ id: "gateway-connectivity", severity: "blocker" }),
      expect.objectContaining({ id: "gateway-auth", severity: "warning" }),
      expect.objectContaining({ id: "notification-target", severity: "warning", value: "slack" }),
    ]));
    expect(report.nextSteps).toEqual(expect.arrayContaining([
      "Create the active openclaw.json at this path or rerun Phoenix with --config <path>.",
      "Fix gateway configuration until openclaw status --json reports gateway.misconfigured=false and gateway.reachable=true.",
      "Pass --notify-target <target> with the same --notify mode you intend to use for self-heal runs.",
    ]));
  });

  it("flags an inaccessible openclaw binary before attempting runtime checks", async () => {
    const homeDir = await makeTempDir("phoenix-doctor-bin-");
    const stateDir = path.join(homeDir, ".openclaw");
    const configPath = path.join(stateDir, "openclaw.json");
    const outputDir = path.join(homeDir, "archives");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(configPath, "{}\n", "utf8");
    await fs.mkdir(outputDir, { recursive: true });

    const report = await runPhoenixDoctor({
      configPath,
      openclawBin: path.join(homeDir, "missing-openclaw"),
      outputDir,
      env: { ...process.env, HOME: homeDir },
    });

    expect(report.ok).toBe(false);
    expect(report.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "openclaw-bin", severity: "blocker" }),
      expect.objectContaining({ id: "gateway-connectivity", severity: "info" }),
      expect.objectContaining({ id: "gateway-auth", severity: "info" }),
    ]));
  });
});