import { spawn } from "node:child_process";

type BackupCreateResult = {
  archivePath?: string;
  createdAt?: string;
};

export type OpenClawStatusResult = {
  gateway?: {
    reachable?: boolean;
    misconfigured?: boolean;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type BackupVerifyResult = {
  ok: true;
  archivePath: string;
  archiveRoot: string;
  createdAt: string;
  runtimeVersion: string;
  assetCount: number;
  entryCount: number;
};

export async function runOpenClawJsonCommand(options: {
  openclawBin: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  label: string;
}): Promise<string> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const child = spawn(options.openclawBin, options.args, {
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${options.label} exited via signal ${signal}`));
        return;
      }
      resolve(code ?? 1);
    });
  });
  const stdoutText = stdout.join("").trim();
  const stderrText = stderr.join("").trim();
  if (exitCode !== 0) {
    throw new Error(
      `${options.label} failed with exit ${exitCode}${stderrText ? `: ${stderrText}` : stdoutText ? `: ${stdoutText}` : ""}`,
    );
  }
  return stdoutText;
}

export async function runOpenClawBackupCreate(options: {
  openclawBin: string;
  outputDir: string;
  env?: NodeJS.ProcessEnv;
}): Promise<BackupCreateResult> {
  const stdoutText = await runOpenClawJsonCommand({
    openclawBin: options.openclawBin,
    args: ["backup", "create", "--output", options.outputDir, "--json"],
    env: options.env,
    label: "openclaw backup create",
  });
  if (!stdoutText) {
    return {};
  }
  try {
    return JSON.parse(stdoutText) as BackupCreateResult;
  } catch {
    return {};
  }
}

export async function runOpenClawBackupVerify(options: {
  openclawBin: string;
  archivePath: string;
  env?: NodeJS.ProcessEnv;
}): Promise<BackupVerifyResult> {
  const stdoutText = await runOpenClawJsonCommand({
    openclawBin: options.openclawBin,
    args: ["backup", "verify", options.archivePath, "--json"],
    env: options.env,
    label: "openclaw backup verify",
  });
  if (!stdoutText) {
    throw new Error("openclaw backup verify returned no JSON output");
  }
  try {
    return JSON.parse(stdoutText) as BackupVerifyResult;
  } catch (error) {
    throw new Error(`openclaw backup verify returned invalid JSON: ${String(error)}`);
  }
}

export async function runOpenClawStatus(options: {
  openclawBin: string;
  env?: NodeJS.ProcessEnv;
}): Promise<OpenClawStatusResult> {
  const stdoutText = await runOpenClawJsonCommand({
    openclawBin: options.openclawBin,
    args: ["status", "--json"],
    env: options.env,
    label: "openclaw status --json",
  });
  if (!stdoutText) {
    throw new Error("openclaw status --json returned no JSON output");
  }
  try {
    return JSON.parse(stdoutText) as OpenClawStatusResult;
  } catch (error) {
    throw new Error(`openclaw status --json returned invalid JSON: ${String(error)}`);
  }
}