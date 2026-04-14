import path from "node:path";
import { spawn } from "node:child_process";

type BackupCreateResult = {
  archivePath?: string;
  createdAt?: string;
  onlyConfig?: boolean;
};

export type OpenClawBackupVariant = "full" | "config-only";

export type OpenClawCreatedBackup = {
  archivePath: string;
  createdAt?: string;
  onlyConfig: boolean;
  variant: OpenClawBackupVariant;
};

export type OpenClawBackupBatchResult = {
  archivePath?: string;
  configOnlyArchivePath?: string;
  full?: OpenClawCreatedBackup;
  configOnly?: OpenClawCreatedBackup;
  error?: string;
};

export const CONFIG_ONLY_BACKUP_DIRNAME = "config-only";

export function resolveConfigOnlyBackupOutputDir(outputDir: string): string {
  return path.join(outputDir, CONFIG_ONLY_BACKUP_DIRNAME);
}

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

export async function runOpenClawCommand(options: {
  openclawBin: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  label: string;
}): Promise<{ stdoutText: string; stderrText: string }> {
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
  return { stdoutText, stderrText };
}

export async function runOpenClawJsonCommand(options: {
  openclawBin: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  label: string;
}): Promise<string> {
  const { stdoutText } = await runOpenClawCommand(options);
  return stdoutText;
}

export async function runOpenClawBackupCreate(options: {
  openclawBin: string;
  outputDir: string;
  env?: NodeJS.ProcessEnv;
  onlyConfig?: boolean;
}): Promise<BackupCreateResult> {
  const onlyConfig = Boolean(options.onlyConfig);
  const stdoutText = await runOpenClawJsonCommand({
    openclawBin: options.openclawBin,
    args: ["backup", "create", "--output", options.outputDir, ...(onlyConfig ? ["--only-config"] : []), "--json"],
    env: options.env,
    label: onlyConfig ? "openclaw backup create --only-config" : "openclaw backup create",
  });
  if (!stdoutText) {
    return { onlyConfig };
  }
  try {
    return {
      ...(JSON.parse(stdoutText) as BackupCreateResult),
      onlyConfig,
    };
  } catch {
    return { onlyConfig };
  }
}

function toCreatedBackup(result: BackupCreateResult, variant: OpenClawBackupVariant): OpenClawCreatedBackup | undefined {
  if (!result.archivePath) {
    return undefined;
  }
  return {
    archivePath: path.resolve(result.archivePath),
    createdAt: result.createdAt,
    onlyConfig: variant === "config-only",
    variant,
  };
}

export async function runOpenClawBackupCreateBatch(options: {
  openclawBin: string;
  outputDir: string;
  env?: NodeJS.ProcessEnv;
}): Promise<OpenClawBackupBatchResult> {
  const errors: string[] = [];
  let configOnly: OpenClawCreatedBackup | undefined;
  let full: OpenClawCreatedBackup | undefined;

  try {
    const result = await runOpenClawBackupCreate({
      openclawBin: options.openclawBin,
      outputDir: resolveConfigOnlyBackupOutputDir(options.outputDir),
      env: options.env,
      onlyConfig: true,
    });
    configOnly = toCreatedBackup(result, "config-only");
    if (!configOnly) {
      errors.push("config-only backup returned no archive path");
    }
  } catch (error) {
    errors.push(`config-only backup failed: ${String(error)}`);
  }

  try {
    const result = await runOpenClawBackupCreate({
      openclawBin: options.openclawBin,
      outputDir: options.outputDir,
      env: options.env,
    });
    full = toCreatedBackup(result, "full");
    if (!full) {
      errors.push("full backup returned no archive path");
    }
  } catch (error) {
    errors.push(`full backup failed: ${String(error)}`);
  }

  return {
    archivePath: full?.archivePath,
    configOnlyArchivePath: configOnly?.archivePath,
    full,
    configOnly,
    error: errors.length > 0 ? errors.join("; ") : undefined,
  };
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
