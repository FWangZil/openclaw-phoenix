# openclaw-phoenix

`openclaw-phoenix` is a standalone operator tool for backing up an already deployed OpenClaw instance and, when used as an internal hook, rolling back to the last known-good backup after a failed startup.

It does **not** require changes to OpenClaw source code or upstream OpenClaw docs. It works by calling the deployed `openclaw` CLI and, for hook mode, by installing a managed internal hook into the deployment's existing state/config paths.

## Process archive

Historical implementation context for future maintainers/operators lives in:

- `docs/archive/README.md`
- `docs/archive/project-journey.md`
- `docs/archive/operator-handoff.md`

## Install and run

From a standalone checkout:

```sh
cd openclaw-phoenix
npm install
```

`npm install` runs the package `prepare` script, builds `dist/`, and makes the packaged `openclaw-phoenix` bin executable via `dist/cli.js`.

Common ways to run it after install:

```sh
npx openclaw-phoenix --help
npm link && openclaw-phoenix --help
node dist/cli.js --help
```

## Commands

- `openclaw-phoenix watch`
  - Long-running watcher for config/auth changes.
  - Runs `openclaw backup create --output ... --json` after debounced changes and then prunes old archives.
- `openclaw-phoenix restore <archive>`
  - Verifies an archive with `openclaw backup verify <archive> --json` and restores it into the *current* deployment paths.
- `openclaw-phoenix hook install`
  - Injects a managed internal hook into an existing OpenClaw deployment.
- `openclaw-phoenix hook run`
  - Internal command used by the installed hook to run backup → health check → rollback/retain.
- `openclaw-phoenix hook remove`
  - Removes only the Phoenix-managed hook entry and files.

## Operator assumptions and path resolution

Phoenix intentionally assumes it is working against an existing OpenClaw deployment.

### `openclaw` binary

- Default: `openclaw`
- Override: `--openclaw-bin <path>`

If `openclaw` is not on `PATH`, point Phoenix at the deployed binary explicitly.

### Root config path

Phoenix resolves the deployment config in this order:

1. `--config <path>`
2. `OPENCLAW_CONFIG_PATH`
3. `CLAWDBOT_CONFIG_PATH`
4. `<stateDir>/openclaw.json`
5. Legacy fallbacks in the same state dir: `clawdbot.json`, `moldbot.json`, `moltbot.json`

### State dir

Phoenix resolves the deployment state dir in this order:

1. `OPENCLAW_STATE_DIR`
2. `CLAWDBOT_STATE_DIR`
3. `~/.openclaw` if it already exists
4. Legacy dirs if present: `~/.clawdbot`, `~/.moldbot`, `~/.moltbot`
5. Otherwise defaults to `~/.openclaw`

### OAuth / credentials dir

- Default: `<stateDir>/credentials`
- Override: `OPENCLAW_OAUTH_DIR`

### Backup output dir

- Default: `~/openclaw-backups`
- Override: `--output <dir>`

Phoenix stores watch-mode archives, hook-mode archives, and its hook state file in this output directory.

## Watch flow

Use `watch` when you want Phoenix to run continuously beside an existing deployment and create backups whenever operator-managed config/auth state changes.

Example:

```sh
openclaw-phoenix watch \
  --config ~/.openclaw/openclaw.json \
  --openclaw-bin /usr/local/bin/openclaw \
  --output ~/openclaw-backups \
  --retain 100 \
  --debounce-ms 1000
```

What `watch` does:

1. Resolves the current deployment paths.
2. Watches:
   - the root OpenClaw config file,
   - the OAuth/credentials directory,
   - any `$include` config files it can discover recursively,
   - auth store files for the default agent and referenced agents.
3. Debounces change bursts (default `1000ms`).
4. After the debounce window, runs `openclaw backup create --output <dir> --json`.
5. Prunes old `*-openclaw-backup.tar.gz` archives down to `--retain` (default `100`).

Operational notes:

- `watch` is **change-driven**. It does not create an initial backup on startup.
- If the root config file changes, Phoenix refreshes the derived watch target set before the next backup cycle.
- Invalid/missing config-derived paths are reported as warnings; the watcher stays up and continues watching the base paths it can resolve.
- A failed backup cycle logs an error but does not terminate the watch session.

## Restore flow

Use `restore` when you want to take a verified backup archive and write it into the current deployment's live paths.

Preview only:

```sh
openclaw-phoenix restore ~/openclaw-backups/2026-03-09T00-00-00.000Z-openclaw-backup.tar.gz \
  --config ~/.openclaw/openclaw.json \
  --openclaw-bin /usr/local/bin/openclaw \
  --dry-run
```

Apply the restore:

```sh
openclaw-phoenix restore ~/openclaw-backups/2026-03-09T00-00-00.000Z-openclaw-backup.tar.gz \
  --config ~/.openclaw/openclaw.json \
  --openclaw-bin /usr/local/bin/openclaw \
  --yes
```

What `restore` does:

1. Runs `openclaw backup verify <archive> --json` first.
2. Reads the archive manifest and archive contents.
3. Resolves the *current* deployment paths via the same watch-plan logic Phoenix uses elsewhere.
4. Maps manifest assets into the current deployment's config/state/credentials locations.
5. Prints the restore plan.
6. Requires confirmation unless you pass `--yes`.
7. Copies files/directories into place.

Safety rules:

- `--dry-run` validates and prints the plan without writing files.
- Restore refuses to write through symlinked directories or symlinked destination files.
- Restore refuses malformed archive paths and duplicate destination paths.
- Restore is intended for archives produced by OpenClaw backup; Phoenix validates the manifest/archive structure before writing.

## Hook install/remove behavior

Use `hook install` to add Phoenix to an already deployed OpenClaw instance.

Example:

```sh
openclaw-phoenix hook install \
  --config ~/.openclaw/openclaw.json \
  --openclaw-bin /usr/local/bin/openclaw \
  --phoenix-bin /usr/local/bin/openclaw-phoenix \
  --output ~/openclaw-backups \
  --retain 100 \
  --event gateway:startup
```

Default event:

- Phoenix subscribes to the internal hook event `gateway:startup` unless you override it with `--event <type:action>`.
- The event key must contain a colon. Phoenix rejects invalid keys.

Install behavior:

- Creates the hook directory at `<stateDir>/hooks/openclaw-phoenix-backup-rollback`.
- Writes three managed files there:
  - `HOOK.md`
  - `handler.js`
  - `install-record.json`
- Updates the deployment config under `hooks.internal.entries.openclaw-phoenix-backup-rollback`.
- Forces `hooks.internal.enabled = true` so the hook can actually run.
- Records the prior `hooks.internal.enabled` state (`unset`, `false`, or `true`) for later removal.

The install is intentionally conservative:

- It refuses to overwrite an unmanaged hook directory.
- It refuses to overwrite an unrelated hook entry with the same name.
- It leaves unrelated internal hook entries untouched.

Recommended practice:

- If you omit `--phoenix-bin`, Phoenix captures the **current CLI invocation** and writes a working handler command for common modes such as `openclaw-phoenix ...`, `node dist/cli.js ...`, or `node --import tsx src/cli.ts ...`.
- For long-lived deployed installs, still prefer passing `--phoenix-bin` explicitly so the handler always points at the exact executable or entrypoint you intend to keep available.
- If you install from a source checkout, do not rely on shell aliases or a temporary working directory path.

Remove the managed hook:

```sh
openclaw-phoenix hook remove --config ~/.openclaw/openclaw.json
```

Remove behavior:

- Deletes only `hooks.internal.entries.openclaw-phoenix-backup-rollback`.
- Deletes the Phoenix-managed hook directory.
- Preserves unrelated hook entries.
- Restores the previous `hooks.internal.enabled` state when Phoenix recorded it as `false` or `unset`.
- If internal hooks were already enabled before install, Phoenix leaves them enabled.
- Refuses to remove an unmanaged hook directory.

## What the installed hook actually runs

The generated `handler.js` is a thin adapter for operators, not a second implementation of Phoenix logic.

At runtime it:

1. Spawns:

   the recorded Phoenix command plus:

   `hook run --json --config ... --openclaw-bin ... --output ... --retain ...`

2. Collects stdout/stderr from that child process.
3. Parses stdout as JSON when possible.
4. If the OpenClaw hook event object has a `messages` array and Phoenix returned a notification, pushes that notification into `event.messages`.
5. Logs failures to stderr when the child exits non-zero or errors.

This means the deployed hook behavior is still defined by the standalone Phoenix CLI, not by custom logic embedded into OpenClaw.

## Internal `hook run` operator behavior

`hook run` is the hook's workhorse command. Operators normally invoke it manually only for testing/debugging.

Example:

```sh
openclaw-phoenix hook run \
  --config ~/.openclaw/openclaw.json \
  --openclaw-bin /usr/local/bin/openclaw \
  --output ~/openclaw-backups \
  --retain 100 \
  --json
```

Flow:

1. Creates a fresh backup with `openclaw backup create --output <dir> --json`.
2. Runs `openclaw status --json`.
3. Evaluates health.
4. If healthy, promotes the fresh backup to `latestKnownGoodArchivePath`.
5. If unhealthy, attempts restore from the previously promoted known-good archive.
6. Writes Phoenix state to `<outputDir>/.openclaw-phoenix-state.json`.
7. Runs retention pruning.

`--json` prints a summary object containing:

- `ok`
- `healthy`
- `backupArchivePath`
- `backupError`
- `latestKnownGoodArchivePath`
- `healthReason`
- `rollback`
- `retention`
- `notification`

Exit behavior:

- Healthy path: success requires a healthy status and no backup error.
- Unhealthy path: success requires a successful rollback restore.

## Health-check semantics

Phoenix treats `openclaw status --json` as healthy **only** when:

- `gateway.reachable === true`, and
- `gateway.misconfigured !== true`

Phoenix treats the deployment as unhealthy when any of the following is true:

- `gateway.misconfigured === true`
- `gateway.reachable === false`
- `gateway.reachable` is missing or not `true`
- `openclaw status --json` fails or returns invalid/no JSON

This is intentionally startup-oriented: Phoenix is guarding the deployment based on whether the gateway comes up reachable and not misconfigured.

## Latest-known-good promotion, rollback, and retention

Phoenix tracks hook state in:

- `<outputDir>/.openclaw-phoenix-state.json`

Promotion rules:

- A backup becomes the `latestKnownGoodArchivePath` only when **both** of these are true:
  - the fresh backup command produced an archive path, and
  - the status check was healthy.

Rollback rules:

- On an unhealthy result, Phoenix tries to restore the previously promoted `latestKnownGoodArchivePath`.
- It does **not** promote the current run's backup when the health check is unhealthy.
- If there is no known-good archive yet, Phoenix reports the unhealthy state but has nothing to restore.

Retention rules:

- Normal retention keeps the newest `--retain` matching archives.
- The current `latestKnownGoodArchivePath` is always added to the keep set.
- Therefore, a known-good archive is protected from pruning even when it is older than the normal retention window.

## Suggested operator workflows

Continuous backup watcher beside a running deployment:

```sh
openclaw-phoenix watch --config ~/.openclaw/openclaw.json --output ~/openclaw-backups
```

Install startup rollback protection into an existing deployment:

```sh
openclaw-phoenix hook install \
  --config ~/.openclaw/openclaw.json \
  --openclaw-bin /usr/local/bin/openclaw \
  --phoenix-bin /usr/local/bin/openclaw-phoenix
```

Manually test the installed hook flow:

```sh
openclaw-phoenix hook run --config ~/.openclaw/openclaw.json --json
```

Remove Phoenix-managed hook injection cleanly:

```sh
openclaw-phoenix hook remove --config ~/.openclaw/openclaw.json
```