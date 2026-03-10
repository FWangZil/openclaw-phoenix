import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import * as tar from "tar"

const repoRoot = path.resolve(import.meta.dirname, "..")
const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "phoenix-standalone-runtime-"))
const homeDir = path.join(runtimeDir, "home")
const stateDir = path.join(homeDir, ".openclaw")
const outputDir = path.join(homeDir, "archives")
const configPath = path.join(stateDir, "openclaw.json")
const liveConfigPath = path.join(stateDir, "runtime-config.json")
const stagedDir = path.join(runtimeDir, "staged")
const stagedCliPath = path.join(stagedDir, "dist", "cli.js")

async function run(args, options = {}) {
  const child = spawn(process.execPath, args, {
    cwd: options.cwd ?? stagedDir,
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  })
  const stdout = []
  const stderr = []
  child.stdout.on("data", (chunk) => stdout.push(String(chunk)))
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)))
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (exitCode, signal) => signal ? reject(new Error(`command exited via ${signal}`)) : resolve(exitCode ?? 1))
  })
  return { code, stdout: stdout.join(""), stderr: stderr.join("") }
}

async function waitFor(check, timeoutMs = 7_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`condition not met within ${timeoutMs}ms`)
}

async function buildArchiveFixture({ archiveRoot, sourceStateDir, version }) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "phoenix-standalone-archive-"))
  const rootDir = path.join(tempDir, archiveRoot)
  const archivePath = path.join(tempDir, `${archiveRoot}.tar.gz`)
  const archiveEntryPath = path.posix.join(archiveRoot, "payload", "posix", sourceStateDir.slice(1), "runtime-config.json")
  await fs.mkdir(path.dirname(path.join(tempDir, archiveEntryPath)), { recursive: true })
  await fs.mkdir(rootDir, { recursive: true })
  await fs.writeFile(path.join(rootDir, "manifest.json"), `${JSON.stringify({
    schemaVersion: 1,
    archiveRoot,
    createdAt: `${archiveRoot.slice(0, 10)}T00:00:00.000Z`,
    paths: {
      stateDir: sourceStateDir,
      configPath: path.join(sourceStateDir, "openclaw.json"),
      oauthDir: path.join(sourceStateDir, "credentials"),
    },
    assets: [{
      kind: "config",
      sourcePath: path.join(sourceStateDir, "runtime-config.json"),
      archivePath: archiveEntryPath,
    }],
  }, null, 2)}\n`, "utf8")
  await fs.writeFile(path.join(tempDir, archiveEntryPath), JSON.stringify({ version }), "utf8")
  await tar.c({ file: archivePath, gzip: true, cwd: tempDir }, [archiveRoot])
  return archivePath
}

async function stageRuntime() {
  await fs.mkdir(path.join(stagedDir, "dist"), { recursive: true })
  await fs.cp(path.join(repoRoot, "dist"), path.join(stagedDir, "dist"), { recursive: true })
  await fs.copyFile(path.join(repoRoot, "package.json"), path.join(stagedDir, "package.json"))
  await fs.symlink(path.join(repoRoot, "node_modules"), path.join(stagedDir, "node_modules"), "dir")
}

async function createFakeOpenClaw({ archiveQueuePath, commandLogPath, notificationModePath, restoreMarkerPath, statusModePath }) {
  const fakeOpenClawPath = path.join(homeDir, "fake-openclaw.mjs")
  await fs.writeFile(fakeOpenClawPath, `#!/usr/bin/env node
import fs from "node:fs/promises"
import path from "node:path"
const args = process.argv.slice(2)
const appendLog = async (entry) => fs.appendFile(${JSON.stringify(commandLogPath)}, entry + "\\n", "utf8")
if (args[0] === "backup" && args[1] === "create") {
  await appendLog("backup create")
  const queue = JSON.parse(await fs.readFile(${JSON.stringify(archiveQueuePath)}, "utf8"))
  const nextArchive = queue.shift()
  await fs.writeFile(${JSON.stringify(archiveQueuePath)}, JSON.stringify(queue), "utf8")
  const outputDir = args[args.indexOf("--output") + 1]
  await fs.mkdir(outputDir, { recursive: true })
  const target = path.join(outputDir, path.basename(nextArchive))
  await fs.copyFile(nextArchive, target)
  console.log(JSON.stringify({ archivePath: target, createdAt: "2026-03-10T00:00:00.000Z" }))
  process.exit(0)
}
if (args[0] === "backup" && args[1] === "verify") {
  await appendLog("backup verify")
  await fs.writeFile(${JSON.stringify(restoreMarkerPath)}, args[2], "utf8")
  console.log(JSON.stringify({ ok: true, archivePath: args[2], archiveRoot: path.basename(args[2], ".tar.gz"), createdAt: "2026-03-10T00:00:00.000Z", runtimeVersion: "test", assetCount: 1, entryCount: 2 }))
  process.exit(0)
}
if (args[0] === "status" && args[1] === "--json") {
  await appendLog("status")
  const mode = (await fs.readFile(${JSON.stringify(statusModePath)}, "utf8")).trim()
  console.log(JSON.stringify({ gateway: { reachable: mode === "healthy", misconfigured: false } }))
  process.exit(0)
}
if (args[0] === "gateway" && args[1] === "call" && args[2] === "send") {
  await appendLog("gateway call send")
  if (((await fs.readFile(${JSON.stringify(notificationModePath)}, "utf8")).trim() || "success") === "fail") {
    console.error("gateway send unavailable")
    process.exit(1)
  }
  console.log(JSON.stringify({ ok: true }))
  process.exit(0)
}
console.error("unexpected fake openclaw args: " + args.join(" "))
process.exit(1)
`, { encoding: "utf8", mode: 0o755 })
  return fakeOpenClawPath
}

await stageRuntime()
await fs.mkdir(stateDir, { recursive: true })
await fs.writeFile(configPath, "{}\n", "utf8")
await fs.writeFile(liveConfigPath, JSON.stringify({ version: "healthy" }), "utf8")

const badConfigDir = path.join(runtimeDir, "bad-config")
await fs.mkdir(badConfigDir, { recursive: true })
const doctorFailure = await run([stagedCliPath, "doctor", "--json", "--config", badConfigDir, "--openclaw-bin", path.join(runtimeDir, "missing-openclaw"), "--output", outputDir])
assert.equal(doctorFailure.code, 1)
const doctorReport = JSON.parse(doctorFailure.stdout)
assert.equal(doctorReport.items.find((item) => item.id === "openclaw-bin")?.severity, "blocker")
assert.equal(doctorReport.items.find((item) => item.id === "config-path")?.severity, "blocker")

const sourceStateDir = path.join("/tmp", "phoenix-standalone-source")
const healthyArchive = await buildArchiveFixture({ archiveRoot: "2026-03-10T00-00-00.000Z-openclaw-backup", sourceStateDir, version: "healthy" })
const unhealthyArchive = await buildArchiveFixture({ archiveRoot: "2026-03-10T01-00-00.000Z-openclaw-backup", sourceStateDir, version: "broken" })
const watchArchive = await buildArchiveFixture({ archiveRoot: "2026-03-10T02-00-00.000Z-openclaw-backup", sourceStateDir, version: "healthy-watch" })
const archiveQueuePath = path.join(homeDir, "archive-queue.json")
const commandLogPath = path.join(homeDir, "command-log.txt")
const notificationModePath = path.join(homeDir, "notification-mode.txt")
const restoreMarkerPath = path.join(homeDir, "restore-marker.txt")
const statusModePath = path.join(homeDir, "status-mode.txt")
await fs.writeFile(archiveQueuePath, JSON.stringify([healthyArchive, unhealthyArchive]), "utf8")
await fs.writeFile(notificationModePath, "success", "utf8")
await fs.writeFile(statusModePath, "healthy", "utf8")
const fakeOpenClawPath = await createFakeOpenClaw({ archiveQueuePath, commandLogPath, notificationModePath, restoreMarkerPath, statusModePath })
const env = { ...process.env, HOME: homeDir, OPENCLAW_STATE_DIR: stateDir, VITEST: "true" }

const firstHookRun = await run([stagedCliPath, "hook", "run", "--json", "--config", configPath, "--openclaw-bin", fakeOpenClawPath, "--output", outputDir, "--retain", "2"], { env })
assert.equal(firstHookRun.code, 0)
assert.equal(JSON.parse(firstHookRun.stdout).healthy, true)

await fs.writeFile(liveConfigPath, JSON.stringify({ version: "bad" }), "utf8")
await fs.writeFile(statusModePath, "unhealthy", "utf8")
await fs.writeFile(notificationModePath, "fail", "utf8")
const secondHookRun = await run([
  stagedCliPath,
  "hook",
  "run",
  "--json",
  "--config",
  configPath,
  "--openclaw-bin",
  fakeOpenClawPath,
  "--output",
  outputDir,
  "--retain",
  "2",
  "--notify",
  "exceptional-only",
  "--notify-target",
  "room://operators",
], { env })
assert.equal(secondHookRun.code, 0)
const secondHookResult = JSON.parse(secondHookRun.stdout)
assert.equal(secondHookResult.rollbackRestored, true)
assert.equal(secondHookResult.notificationDelivery.results[0]?.delivered, false)
assert.match(secondHookResult.notificationDelivery.results[0]?.error ?? "", /openclaw gateway call send/)

await fs.writeFile(archiveQueuePath, JSON.stringify([watchArchive]), "utf8")
await fs.writeFile(commandLogPath, "", "utf8")
await fs.writeFile(statusModePath, "healthy", "utf8")
const watchProcess = spawn(process.execPath, [stagedCliPath, "watch", "--self-heal", "--config", configPath, "--openclaw-bin", fakeOpenClawPath, "--output", outputDir, "--retain", "2", "--debounce-ms", "40", "--notify", "all", "--notify-target", "room://operators"], {
  cwd: stagedDir,
  env,
  stdio: ["ignore", "pipe", "pipe"],
})
let watchStdout = ""
let watchStderr = ""
watchProcess.stdout.on("data", (chunk) => {
  watchStdout += String(chunk)
})
watchProcess.stderr.on("data", (chunk) => {
  watchStderr += String(chunk)
})
await new Promise((resolve) => setTimeout(resolve, 200))
await fs.writeFile(configPath, `${JSON.stringify({ sequence: 1 }, null, 2)}\n`, "utf8")
await waitFor(async () => {
  const commandLog = await fs.readFile(commandLogPath, "utf8").catch(() => "")
  return commandLog.includes("gateway call send") && /notification delivery failed \(healthy\)/.test(watchStderr)
})
watchProcess.kill("SIGINT")
const watchExitCode = await new Promise((resolve, reject) => {
  watchProcess.once("error", reject)
  watchProcess.once("exit", (code, signal) => signal ? reject(new Error(`watch exited via ${signal}`)) : resolve(code ?? 1))
})
assert.equal(watchExitCode, 0)
assert.match(watchStdout, /watch mode: self-heal/)
assert.match(watchStderr, /notification delivery failed \(healthy\)/)
assert.ok(await fs.stat(path.join(outputDir, ".openclaw-phoenix-state.json")))

console.log("standalone deployed-path smoke passed")