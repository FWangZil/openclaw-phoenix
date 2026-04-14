import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("package.json scripts", () => {
  it("exposes direct web console startup scripts", async () => {
    const packageJsonPath = path.resolve(import.meta.dirname, "..", "package.json");
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts).toMatchObject({
      "dev:web": "node ./scripts/web-dev.mjs",
      "start:web": "node --import tsx ./src/cli.ts web serve",
      "start:web:dist": "node ./dist/cli.js web serve",
      "web:start": "node --import tsx ./src/cli.ts web serve",
      "web:dev": "node ./scripts/web-dev.mjs",
      "web:start:dist": "node ./dist/cli.js web serve",
    });
  });
});
