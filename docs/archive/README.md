# Phoenix process archive

This directory preserves the extraction/build-out history for `openclaw-phoenix` so future maintainers and operators of the standalone repo can understand **why** the project looks the way it does, not just how to run it.

## What lives here

- `project-journey.md` — planning decisions, boundary changes, implementation phases, review findings, and the blocker-fix path that made Phoenix genuinely standalone.
- `operator-handoff.md` — practical guidance for maintainers/operators taking ownership of the standalone repo after extraction.

## How to use these docs

- Start with `project-journey.md` if you need the decision history.
- Start with `operator-handoff.md` if you need operational/maintenance guidance.
- Use the root `README.md` for the current command surface and day-to-day operator examples.

## Scope reminder

The core boundary established during the project was: **Phoenix stays a standalone integration layer around deployed `openclaw`, rather than modifying OpenClaw source code or upstream docs.**