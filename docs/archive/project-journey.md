# Phoenix project journey

This document summarizes the full task journey that produced `openclaw-phoenix` as a standalone repo-in-waiting.

## Original goal and boundary change

The original product goal was to protect already deployed OpenClaw instances by adding:

- automatic full backups when config-related files change,
- retention of the newest archives,
- an in-place restore command, and
- a hook-triggered backup/health-check/rollback flow.

The most important planning decision was a boundary change: this work would **not** land as new OpenClaw source changes. Instead, Phoenix would become a separate CLI/project that integrates with deployed OpenClaw installations by calling existing commands such as:

- `openclaw backup create`
- `openclaw backup verify`
- `openclaw status --json`

That decision shaped the whole implementation:

- no OpenClaw source edits were required,
- no new upstream OpenClaw CLI commands were introduced,
- hook integration had to be injected into deployments rather than added upstream, and
- repo extraction/relocation was treated as a packaging/handoff step after the standalone project was ready.

## Open-source alternative assessment

Before implementation, several open-source alternatives were evaluated:

- `borgmatic`
- `Backrest`
- `Kopia`
- `Watchman`
- `etckeeper`

The conclusion was that none of them matched the requested OpenClaw-specific workflow closely enough:

- `borgmatic`, `Backrest`, and `Kopia` are strong backup orchestrators, but they center on their own engines instead of delegating to OpenClaw's native backup/status flows.
- `Watchman` is good at triggering on filesystem changes, but it does not provide retention, restore orchestration, or health-gated rollback on its own.
- `etckeeper` is useful inspiration for config-history thinking, but it is version-control oriented rather than full-archive + manifest + rollback oriented.

The resulting recommendation was to build Phoenix as a small integration layer that borrows ideas from those tools without adopting one of them as the core runtime.

## Implementation phases

### Phase 1: watch and retention

Phoenix first established the continuous backup path:

- watch the active root config,
- recursively discover and watch `$include` config files,
- watch the credentials/OAuth directory,
- watch config-adjacent auth stores under the resolved state dir,
- debounce bursts of file activity into one backup cycle,
- write archives to a stable default output directory (`~/openclaw-backups`), and
- prune only matching `*-openclaw-backup.tar.gz` archives.

Two decisions from this phase matter long term:

1. Phoenix refreshes its watch target set when the root config changes so include-file additions/removals do not require a restart.
2. Retention must operate narrowly and safely; it should touch only Phoenix/OpenClaw backup archives, not unrelated files in the output directory.

### Phase 2: restore

The next slice added an in-place restore command aligned with OpenClaw's existing archive contract.

Key choices:

- Phoenix validates archives by delegating to `openclaw backup verify --json` before writing.
- Restore supports `--dry-run` and requires confirmation (`--yes` for non-interactive use).
- Restore targets are remapped through Phoenix's current deployment path resolution so recovery follows the same config/state assumptions used by watch mode.
- Writes are constrained to manifest-declared content and reject unsafe/traversal/symlinked destinations.

This preserved a single mental model: the same deployment-path logic used to decide what to watch is also used to decide where restores land.

### Phase 3: hook injection and rollback

Phoenix then added a second trigger mode for deployed environments: injected internal hooks.

That phase introduced:

- `hook install` to inject a Phoenix-managed hook into an existing deployment,
- `hook run` as the hook-facing orchestration entrypoint,
- `hook remove` to cleanly undo the managed integration,
- a default `gateway:startup` event with operator override support, and
- latest-known-good tracking so rollback uses the previous healthy archive rather than the archive created by the failing run.

The runtime flow became:

1. `openclaw backup create`
2. `openclaw status --json`
3. mark the new archive known-good if status is healthy
4. otherwise restore the previous known-good archive
5. emit a user-visible notification/log summary
6. run retention while protecting the pinned known-good archive

Important operational semantics from this phase:

- health is intentionally startup-oriented,
- rollback is based on the last known-good archive, not the just-created candidate archive, and
- retention must preserve the pinned recovery point even when it is older than the normal retain window.

### Phase 4: docs and help surface

After the main behaviors existed, Phoenix added standalone operator documentation and CLI help coverage for:

- watch mode,
- restore mode,
- hook install/remove flows,
- `hook run` behavior,
- path-resolution assumptions,
- health-gate semantics, and
- latest-known-good / retention behavior.

The documentation goal was to keep Phoenix self-explanatory without requiring OpenClaw upstream docs changes.

## Independent review findings

An independent final review found that the first "complete" version was **not yet acceptable** for extraction as a standalone repo.

The blockers were:

1. **Not truly standalone**
   - Phoenix still inherited parent-repo TypeScript config.
   - It used undeclared/hoisted `tar` resolution.
   - Success depended on the parent OpenClaw workspace rather than Phoenix being self-contained.
2. **CLI packaging/bin path was not actually deployable**
   - The package bin pointed at `src/cli.ts`.
   - That source entrypoint was not executable as shipped and depended on `tsx` in a dev-only way.
3. **Default `--phoenix-bin` could install a broken hook**
   - Common dev invocation modes recorded a fragile source-path executable that later failed with `EACCES`.
4. **`hook remove` could partially mutate config before refusing removal**
   - This created a correctness/safety gap between config state and on-disk hook ownership validation.

This review was crucial because it changed the definition of done from "works inside the monorepo" to "works as a genuinely standalone project." 

## Blocker-fix path that made Phoenix standalone

The follow-up blocker-fix pass resolved those issues inside `openclaw-phoenix/`.

### Packaging and self-containment fixes

- replaced parent-repo `tsconfig` inheritance with local standalone TypeScript config,
- added a dedicated typecheck config,
- declared the `tar` dependency locally, and
- added standalone ignore/build hygiene for nested-repo packaging.

### Executable CLI fixes

- changed the package bin to `dist/cli.js`,
- added build/prepare steps so install produces built output,
- rewrote the compiled shebang to `#!/usr/bin/env node`, and
- marked the built CLI executable after build.

### Hook install/remove safety fixes

- introduced Phoenix-command recording so install captures a safe command array instead of a fragile single-path default,
- made the generated hook handler spawn the recorded command array,
- validated hook ownership before mutating config during removal, and
- added regression coverage for the refusal path.

### Validation that closed the review

The blocker-fix pass explicitly revalidated the standalone package with:

- `npm test`
- `npm run typecheck`
- `npm run build`
- `./dist/cli.js --help`
- `npm pack --dry-run`

Those checks mattered because they proved Phoenix no longer depended on the parent repo's layout or runtime story.

## End-state summary

By the end of the task journey, Phoenix had become:

- a standalone CLI focused on deployed OpenClaw instances,
- a wrapper around existing OpenClaw backup/verify/status commands,
- a deployment-hook integration that avoids upstream source changes,
- a project with explicit rollback/retention semantics, and
- a repo that future maintainers can extract, relocate, and evolve independently.

For current operational guidance, use the root `README.md`. For maintainer takeover guidance, use `operator-handoff.md`.