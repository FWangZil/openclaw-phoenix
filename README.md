# openclaw-phoenix

`openclaw-phoenix` is a standalone operator tool for backing up an already deployed OpenClaw instance and, when used as an internal hook, rolling back to the last known-good backup after a failed startup.

It does **not** require changes to OpenClaw source code or upstream OpenClaw docs. It works by calling the deployed `openclaw` CLI and, for hook mode, by installing a managed internal hook into the deployment's existing state/config paths.

## Process archive

Historical implementation context for future maintainers/operators lives in:

- `docs/archive/README.md`
- `docs/archive/project-journey.md`
- `docs/archive/operator-handoff.md`

## Repository baseline

- Repo installs and CI use Bun (`bun.lock`, `packageManager: bun@1.3.10`).
- Runtime target is Node `>=22.12.0`.
- CI validates install, test, typecheck, build, and CLI help smoke.
- Versioning and release expectations for this standalone repo live in `docs/releasing.md`.

## Install and run

From a standalone checkout:

```sh
cd openclaw-phoenix
bun install
```

`bun install` is the repo-default install path. It runs the package `prepare` script, builds `dist/`, and makes the packaged `openclaw-phoenix` bin executable via `dist/cli.js`.

If you specifically want a package-style local install, `npm install` still works, but repo maintenance and CI should stay on Bun so the committed lockfile remains authoritative.

Common ways to run it after install:

```sh
npx openclaw-phoenix --help
npm link && openclaw-phoenix --help
node dist/cli.js --help
```

## Commands

- `openclaw-phoenix doctor`
  - Runs a focused local/runtime preflight before you rely on Phoenix self-heal.
  - Checks `openclaw` binary access, config/state/output paths, obvious permission issues, `openclaw status --json` gateway readiness/auth warnings, and notification-target completeness for the supported send path.
- `openclaw-phoenix watch`
  - Long-running watcher for config/auth changes.
  - Default behavior is backup-only; add `--self-heal` to run the shared backup/status/rollback flow.
  - Runs `openclaw backup create --output ... --json` after debounced changes and then prunes old archives.
- `openclaw-phoenix restore <archive>`
  - Verifies an archive with `openclaw backup verify <archive> --json` and restores it into the *current* deployment paths.
- `openclaw-phoenix hook install`
  - Injects a managed internal hook into an existing OpenClaw deployment.
- `openclaw-phoenix hook run`
  - Internal command used by the installed hook to run backup → health check → rollback/retain.
- `openclaw-phoenix web snapshot`
  - Prints the current Web v1 backend contract JSON for `overview`, `timeline`, `config`, `archives`, and `setup`.
- `openclaw-phoenix web serve`
  - Serves a local-first Phoenix console with Overview, Setup, Activity, Archives, and Configuration views plus explicit low-risk browser actions for `backup now` and `health check now`.
- `openclaw-phoenix hook remove`
  - Removes only the Phoenix-managed hook entry and files.

## Operator assumptions and path resolution

Phoenix intentionally assumes it is working against an existing OpenClaw deployment.

### `openclaw` binary

- Default: `openclaw`
- Override: `--openclaw-bin <path>`

If `openclaw` is not on `PATH`, point Phoenix at the deployed binary explicitly.

## Doctor preflight

Run this before you depend on self-heal in a deployed environment:

```sh
openclaw-phoenix doctor \
  --config ~/.openclaw/openclaw.json \
  --output ~/openclaw-backups \
  --notify exceptional-only \
  --notify-target room://operators
```

Doctor behavior:

- exits non-zero when Phoenix finds a hard blocker
- keeps checks read-only: it does not send notifications and does not mutate deployment state
- uses `openclaw status --json` for the gateway/self-heal probe, so fix whatever that command reports before you trust self-heal
- supports `--json` if you want to consume the report from automation

Recommended doctor practice:

- Run `doctor` with the same `--config`, `--openclaw-bin`, `--output`, and `--notify*` flags you intend to use in production.
- Treat backup-only readiness as the minimum bar for `watch` without `--self-heal`.
- Treat self-heal readiness as the gate for `hook install`, `hook run`, or `watch --self-heal`.
- Re-run doctor after moving the deployment, changing the `openclaw` binary path, or changing notification targets.

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

Phoenix stores watch-mode archives, hook-mode archives, its recovery state file, and the Web v1 structured state file in this output directory.

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
- `watch` is **backup-only by default**. Add `--self-heal` to switch each settled watch cycle into the same shared recovery flow used by `hook run`.
- `watch --notify ...` only has an effect when `--self-heal` is enabled. Backup-only watch cycles only run backup creation plus retention pruning.
- If the root config file changes, Phoenix refreshes the derived watch target set before the next backup cycle.
- Invalid/missing config-derived paths are reported as warnings; the watcher stays up and continues watching the base paths it can resolve.
- A failed backup cycle logs an error but does not terminate the watch session.

### Backup-only vs self-heal watch

Use `watch` modes intentionally:

- `watch` (default, backup-only)
  - creates archives after watched config/auth changes settle
  - prunes retained archives
  - does **not** run `openclaw status --json`
  - does **not** promote `latestKnownGoodArchivePath`
  - does **not** send notifications, even if `--notify*` flags are present
- `watch --self-heal`
  - still creates a fresh backup first
  - then runs the same status/health/rollback/retention/notification flow as `hook run`
  - can promote a backup to `latestKnownGoodArchivePath` after a healthy cycle
  - can attempt rollback after an unhealthy cycle
  - is the only watch mode where `--notify exceptional-only|all` and `--notify-target ...` matter

For most operators, `watch` without `--self-heal` is the safer continuous mode. Add `hook install` for startup rollback protection, and only enable `watch --self-heal` when you explicitly want every settled config/auth change burst to run the full recovery flow.

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

   and any configured `--notify*` flags.

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

It now also includes a stable nested `operation` object that preserves the run origin plus structured backup/health/rollback/notification outcomes for backend consumers.

## Web/backend snapshot contract

If you are running Phoenix from a source checkout, make sure `dist/` is current before using the web commands:

```sh
bun run build
```

`bun install` already does this through the package `prepare` script. Re-run `bun run build` after local source changes or when install scripts were skipped.

Use `web snapshot` when you want a stable structured read model for a future local backend or web UI without parsing logs:

```sh
openclaw-phoenix web snapshot \
  --config ~/.openclaw/openclaw.json \
  --output ~/openclaw-backups \
  > phoenix-web-snapshot.json
```

`web snapshot` writes JSON to stdout. Redirect it to a file, pipe it into `jq`, or let another local process read it directly.

The JSON snapshot includes five top-level sections:

- `overview`: latest action plus latest backup/health/rollback/notification/restore outcomes
- `timeline`: recent structured actions with `origin` preserved as `watch`, `hook`, or `manual`
- `config`: deployment path summary plus last-known per-origin runtime settings
- `archives`: known-good/last-backup pointers plus archive inventory with roles
- `setup`: guided readiness checks for environment, output dir, retain count, self-heal, notifications, and preview commands

Exit behavior for `web snapshot` is read-model focused: Phoenix exits non-zero only when it cannot build the snapshot itself. An unhealthy deployment still produces a successful snapshot so the local console or another reader can explain what happened.

## Local-first web console

Use `web serve` when you want a browser view on top of the same structured snapshot contract with only the lowest-risk explicit actions enabled. Phoenix still does not enable restore, hook mutation, or config editing in the browser:

```sh
openclaw-phoenix web serve \
  --config ~/.openclaw/openclaw.json \
  --output ~/openclaw-backups \
  --host 127.0.0.1 \
  --port 48789
```

When the server starts it prints the listening URL and then waits until you stop it with `Ctrl+C`.

Host/port behavior:

- Default bind is `127.0.0.1:48789`, so Web v1 is local-only by default and intended to be opened from the same machine.
- `--port 0` asks the OS for any free port; Phoenix prints the actual chosen URL after startup.
- `--host 0.0.0.0` or a specific LAN interface makes the console reachable beyond loopback, but you should open it via that machine's actual hostname/IP rather than the literal `0.0.0.0` address.
- Web v1 serves plain local HTTP and does not add browser-side auth or mutation controls. If you bind beyond loopback, put it behind your own access controls.

The local console stays intentionally narrow in this slice:

- `Overview` shows the current protection posture, watch mode, hook install state, latest results, and the latest known-good archive.
- `Overview` now also explains why Phoenix currently looks healthy, limited, degraded, or failed; why rollback did or did not happen; why notifications did or did not fire; and when the browser view may be stale.
- `Overview` also provides two explicit local-only buttons: `Backup now` creates one fresh archive and applies Phoenix retention, while `Health check now` runs `openclaw status --json` and records a structured healthy/unhealthy result without restoring anything.
- `Setup` shows guided prerequisite checks, required vs optional vs advanced settings, hard blockers vs warnings vs info, backup-only vs self-heal readiness, and preview commands you can copy into a terminal yourself.
- `Activity` shows recent Phoenix actions with explicit watch vs hook vs manual origin labels, timestamps, config/output paths, and a short structured outcome summary.
- `Archives` shows the retained archive inventory plus latest-known-good and last-backup roles, sizes, timestamps, and archive paths.
- `Configuration` shows a read-only deployment summary plus last-known watch/hook origin settings, notification policy, and any degraded or warning state.

If Phoenix has not recorded any activity yet, the console renders explicit empty states instead of assuming healthy data exists. The Setup page is preview-only: it explains what command to run next, but the browser does not apply settings. The console also polls the snapshot endpoint to flag stale pages and offer a manual refresh prompt without mutating Phoenix state. If snapshot generation fails for a request, the console returns an explicit error page for that route.

Current Web v1 boundary:

- local-first: optimized for an operator already on the Phoenix host, with loopback binding as the default
- low-risk only: the browser can inspect the current snapshot contract and `/api/snapshot`, and it may run only `backup now` or `health check now`; it does not run restore, install/remove hooks, edit config, or send notifications
- guidance-focused: the browser explains readiness, state, and next-step commands, but you still perform real changes through the `openclaw-phoenix` CLI

## Notification behavior

Phoenix only emits notification summaries from the shared recovery flow used by `hook run` and `watch --self-heal`.

Defaults and requirements:

- Default: `--notify off`
- Modes:
  - `off`: do not attempt remote delivery
  - `exceptional-only`: send only unhealthy rollback/missing-known-good summaries
  - `all`: also send healthy promotion summaries
- Remote delivery requires `--notify-target <target>`.
- `--notify-channel`, `--notify-account`, and `--notify-thread-id` are optional routing hints passed through to `openclaw gateway call send`.
- Passing target flags without `--notify exceptional-only` or `--notify all` does **not** enable delivery.
- If notification delivery fails, Phoenix keeps the underlying recovery result (`ok`, rollback state, latest-known-good promotion) and reports the delivery failure separately.

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

## Recommended deployment patterns

### 1. Continuous backups only

Use this when you want archives for operator-managed config/auth changes but do **not** want Phoenix to attempt restore automatically:

```sh
openclaw-phoenix watch \
  --config ~/.openclaw/openclaw.json \
  --openclaw-bin /usr/local/bin/openclaw \
  --output ~/openclaw-backups
```

This mode is backup-only, ignores notification flags, and never updates the known-good pointer.

### 2. Startup rollback protection

Use this when you want the deployed OpenClaw startup hook to run backup → health check → rollback if startup is unhealthy:

```sh
openclaw-phoenix hook install \
  --config ~/.openclaw/openclaw.json \
  --openclaw-bin /usr/local/bin/openclaw \
  --phoenix-bin /usr/local/bin/openclaw-phoenix \
  --output ~/openclaw-backups
```

Recommended follow-up after install:

```sh
openclaw-phoenix hook run \
  --config ~/.openclaw/openclaw.json \
  --openclaw-bin /usr/local/bin/openclaw \
  --output ~/openclaw-backups \
  --json
```

That manual run is the fastest way to confirm the hook path works and to seed `latestKnownGoodArchivePath` during a known-healthy window.

### 3. Common operator baseline: backup-only watch + startup hook

For most operators, the practical baseline is:

1. run backup-only `watch` continuously beside the deployment,
2. install the startup hook with `hook install`, and
3. manually exercise `hook run --json` once while the deployment is healthy.

That gives you frequent archives for config/auth changes plus startup rollback protection, without making every watch-triggered backup cycle capable of restoring live state.

### 4. Continuous self-heal watch

Only choose `watch --self-heal` when you want Phoenix to evaluate health and possibly roll back after each settled config/auth change burst, not only on startup. Keep the notification flags on this command aligned with the `hook install` or `hook run` flags you expect operators to rely on.

## Troubleshooting

### Watch is running but backups are not firing

Check these first:

- `watch` is change-driven. It does **not** create a backup immediately on startup.
- Phoenix only watches the resolved root config file, the OAuth/credentials dir, discovered `$include` files, and agent auth-store files. Changes outside that footprint do not trigger a cycle.
- Review startup logs for `watching N path(s)` and later `change detected: ...` lines.
- If Phoenix prints `watch target refresh skipped config-derived paths: ...`, fix that config/include/auth-store problem first. The watcher stays up, but only the base paths it could resolve are covered.
- If you changed the root config path or `OPENCLAW_CONFIG_PATH`, restart `watch` with the intended `--config` value and re-run `doctor`.

### Phoenix cannot find `openclaw`

- Run `openclaw-phoenix doctor --openclaw-bin /path/to/openclaw ...`.
- If doctor reports `could not find openclaw on PATH`, either install `openclaw` on `PATH` or pass `--openclaw-bin` explicitly.
- If doctor reports an execute-permission problem, fix the deployed binary permissions for the service user.
- Prefer an explicit `--openclaw-bin` in long-lived operator scripts and hook installs so Phoenix is not dependent on an interactive shell `PATH`.

### Config is missing or invalid

- `doctor` reports a blocker when the resolved root config file is missing, unreadable, or not a file.
- `watch` keeps running if config-derived watch targets cannot be resolved, but it logs warnings and falls back to the base paths it can still monitor.
- `hook install` and `hook remove` both resolve the same deployment paths; if you point Phoenix at the wrong config, you will mutate the wrong deployment.
- If you override the hook event, it must contain a colon, such as `gateway:startup`.

### Notifications are not being delivered

- Notifications are off by default. Passing only `--notify-target` or routing hints does not enable them.
- Remote delivery requires both a sending mode (`--notify exceptional-only` or `--notify all`) and `--notify-target <target>`.
- `--notify-channel`, `--notify-account`, and `--notify-thread-id` are only routing hints for `openclaw gateway call send`; they do not replace the required target.
- Backup-only `watch` never sends notifications. Use `hook run`, the installed hook, or `watch --self-heal` if you expect delivery.
- A delivery failure does **not** undo a healthy promotion or a successful rollback. Phoenix records the recovery result and reports notification delivery failure separately.

### Unhealthy result with no known-good archive

This means Phoenix detected an unhealthy status, but `latestKnownGoodArchivePath` has not been promoted yet.

Common causes:

- Phoenix has only run in backup-only watch mode.
- The first self-heal or hook run happened during an unhealthy startup.
- A prior healthy run created a backup, but the backup path was never promoted because health was not healthy.

How to fix it:

1. bring the deployment to a healthy state,
2. run `openclaw-phoenix hook run --json ...` or let `watch --self-heal` complete a healthy cycle,
3. confirm `latestKnownGoodArchivePath` is present in `<outputDir>/.openclaw-phoenix-state.json` or in `hook run --json` output.

### Rollback failed

When Phoenix reports a rollback failure:

1. identify the archive Phoenix tried to restore from the `hook run --json` output or `<outputDir>/.openclaw-phoenix-state.json`,
2. verify it manually with `openclaw backup verify <archive> --json`,
3. preview the restore plan with `openclaw-phoenix restore <archive> --config ... --openclaw-bin ... --dry-run`,
4. fix the underlying restore problem (for example current destination permissions or path issues),
5. rerun `hook run --json` only after the restore path is healthy enough to trust.

Remember that Phoenix restore safety checks reject malformed archives, duplicate destination writes, and symlinked destination paths.

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

## Operator smoke checks and release baseline

Smallest useful smoke checks for documented CLI surfaces:

```sh
node dist/cli.js doctor --help
node dist/cli.js watch --help
node dist/cli.js hook --help
```

For a fresh checkout or release candidate, the repo baseline remains:

1. `bun install`
2. `bun run test`
3. `bun run typecheck`
4. `bun run build`
5. `bun run smoke:cli`

See `docs/releasing.md` for the standalone repo release expectations.