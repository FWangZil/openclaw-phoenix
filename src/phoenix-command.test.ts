import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePhoenixCommand } from "./phoenix-command.js";

describe("resolvePhoenixCommand", () => {
  it("reuses the current TypeScript entrypoint with node --import tsx by default", () => {
    const command = resolvePhoenixCommand({
      argv: ["node", "src/cli.ts"],
      execPath: "/opt/node/bin/node",
    });
    expect(command).toEqual([
      "/opt/node/bin/node",
      "--import",
      "tsx",
      path.resolve("src/cli.ts"),
    ]);
  });

  it("treats an explicit JavaScript entrypoint as a node script", () => {
    const command = resolvePhoenixCommand({
      phoenixBin: "./dist/cli.js",
      execPath: "/opt/node/bin/node",
    });
    expect(command).toEqual(["/opt/node/bin/node", path.resolve("dist/cli.js")]);
  });

  it("preserves an explicit executable path without wrapping it in node", () => {
    const command = resolvePhoenixCommand({ phoenixBin: "/usr/local/bin/openclaw-phoenix" });
    expect(command).toEqual(["/usr/local/bin/openclaw-phoenix"]);
  });
});