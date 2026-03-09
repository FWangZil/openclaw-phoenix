# Phoenix operator and maintainer handoff

This document captures the practical guidance that emerged during the build-out and review process.

## Guardrails to preserve

Future maintainers should keep these boundaries intact unless there is an explicit product decision to change them:

- Phoenix is a **standalone** project, not an OpenClaw core feature branch.
- Phoenix integrates with deployed OpenClaw instances by calling existing commands and editing deployment config/state only through its own install/remove flows.
- Phoenix should not require OpenClaw source edits, OpenClaw config-schema changes, or upstream docs changes for the core v1 workflows.

In practice, the highest-risk regressions are the ones that accidentally reintroduce monorepo assumptions or make the hook integration mutate deployment state unsafely.

## Operator model to remember

Phoenix assumes there is already a deployed OpenClaw installation.

Core runtime assumptions:

- `openclaw` is discoverable on `PATH`, or operators pass `--openclaw-bin`.
- default backup output is `~/openclaw-backups`.
- hook state lives in the output directory as `.openclaw-phoenix-state.json`.
- hook installation defaults to the `gateway:startup` event unless overridden.

Operationally important behavior:

- `watch` is change-driven and does **not** create an initial backup on startup.
- `restore` validates with OpenClaw before writing and is intended for archives created by OpenClaw backup.
- `hook run` promotes a backup only after a healthy status result.
- rollback uses the previously known-good archive, not the archive created by the failing run.
- retention protects the pinned known-good archive from pruning.

## Recommended operator practices

- Use a backup output directory outside the watched/restored source trees.
- Pass `--phoenix-bin` explicitly for long-lived hook installs so the generated handler points at a stable executable path.
- After installing the hook, run a manual `hook run --json` check before relying on automated rollback in production-like environments.
- Keep the root `README.md` aligned with actual CLI help whenever flags or defaults change.

## Change hotspots for future maintainers

If you modify any of these areas, re-review the surrounding behavior carefully:

### Path resolution and watch scope

`watch`, `restore`, and hook flows share assumptions about config/state/credential paths. Changes here can create subtle drift where Phoenix backs up one set of files but restores to another.

### Hook install/remove ownership rules

The project intentionally refuses to overwrite unrelated hook directories/entries and refuses to remove unmanaged hook artifacts. That conservatism is part of the safety model.

### Health gate semantics

Current health is intentionally narrow and startup-oriented:

- healthy only when `gateway.reachable === true`
- and `gateway.misconfigured !== true`

If OpenClaw later exposes a better overall health contract, this area is a natural upgrade point.

### Build/bin packaging

The independent review showed that a Phoenix repo can appear healthy inside a parent workspace while still being non-standalone. Any packaging changes should be checked from the perspective of a clean standalone install, not just from the original extraction workspace.

## Validation checklist for future changes

When changing Phoenix behavior, rerun the focused checks that proved standalone readiness:

1. `npm test`
2. `npm run typecheck`
3. `npm run build`
4. `./dist/cli.js --help`
5. `npm pack --dry-run`

Additionally:

- verify CLI help/examples if flags or defaults changed,
- verify `hook install` still records a stable runnable Phoenix command,
- verify `hook remove` leaves config and hook-dir state consistent on refusal paths, and
- verify retention still preserves the pinned known-good archive.

## Non-goals that were deliberately left out of v1

These were explicitly kept out of scope and should not be reintroduced accidentally as hidden assumptions:

- cloud/sync backup support,
- partial or path-filtered restore,
- background service installation (launchd/systemd/etc.), and
- new OpenClaw upstream commands or source changes just to support Phoenix.

## Handoff summary

If you are taking ownership of the standalone repo, the main thing to preserve is the original design contract:

**Phoenix succeeds when it remains a small, self-contained safety layer around deployed OpenClaw instances, with conservative hook mutation behavior and validation that proves it works outside the parent monorepo.**