import { chmod, readFile, writeFile } from "node:fs/promises";

const cliUrl = new URL("../dist/cli.js", import.meta.url);
const cliContents = await readFile(cliUrl, "utf8");
const normalizedCli = cliContents.replace(/^#!.*\n/u, "#!/usr/bin/env node\n");

await writeFile(cliUrl, normalizedCli, "utf8");
await chmod(cliUrl, 0o755);