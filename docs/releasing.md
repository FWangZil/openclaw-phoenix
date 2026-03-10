# Releasing

This repo now has a minimal standalone release baseline.

## Package manager and runtime

- Repo installs and CI use Bun. The committed lockfile is `bun.lock`, and `package.json` declares `bun@1.3.10` as the repo package manager.
- Runtime target is Node `>=22.12.0`.
- From a fresh checkout, use `bun install`.
- In automation where install and build are split, use `bun install --frozen-lockfile --ignore-scripts`, then run `bun run build` explicitly.

## Validation baseline

Every change intended for release readiness should pass:

1. `bun run test`
2. `bun run typecheck`
3. `bun run build`
4. `bun run smoke:cli`

The repo CI workflow runs that same sequence on pushes and pull requests.

## Version expectations

- The standalone repo version lives in `package.json`.
- Bump that version when making a release-worthy standalone change.
- Keep release notes and tags aligned to the same `package.json` version when you cut a repo release.

## Install and distribution expectations

- The current package is still marked `private: true`.
- That means the release baseline is for source checkout / repository release validation, not npm publication.
- If npm publication is introduced later, remove `private: true` and add publish-specific automation in a separate change.