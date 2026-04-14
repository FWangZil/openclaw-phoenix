# Gateway Phoenix Watch Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add gateway phoenix behavior to Phoenix watch so CLI watch and web watch both restart the local gateway when port 18789 is down after a non-config cycle or after a rollback restore.

**Architecture:** Keep the behavior inside `src/watch.ts`, because both CLI `watch` and web `watch-start` already share `startBackupWatch()`. Add a small gateway watchdog helper that probes localhost port `18789`, runs `openclaw gateway start`, and falls back to `openclaw gateway install` plus `openclaw gateway start` when needed.

**Tech Stack:** TypeScript, Vitest, chokidar, Node `net`/`child_process`

### Task 1: Lock the new watch behavior with failing tests

**Files:**
- Modify: `src/watch.test.ts`
- Test: `src/watch.test.ts`

**Step 1: Write the failing test**

Add one test for backup-only watch where a non-config file change triggers a cycle and port `18789` is reported down, expecting `gateway start` to run.

Add one test for self-heal watch where rollback restore succeeds while the port is down, expecting `gateway start`, then `gateway install`, then `gateway start`.

**Step 2: Run test to verify it fails**

Run: `npm test -- src/watch.test.ts`

Expected: FAIL because watch does not yet probe the port or invoke gateway restart commands.

### Task 2: Implement shared gateway phoenix recovery in watch

**Files:**
- Modify: `src/watch.ts`
- Modify: `src/backup.ts`

**Step 1: Write minimal implementation**

Add a reusable helper to run non-JSON `openclaw gateway ...` commands, add a localhost port probe for `18789`, and wire watch cycles to call the helper when:
- the settled cycle did not include a config change, or
- a self-heal cycle restored a backup.

**Step 2: Keep behavior small and observable**

Log when Phoenix detects the missing gateway listener, when `gateway start` succeeds, and when Phoenix falls back to `gateway install` plus `gateway start`.

### Task 3: Verify and clean up

**Files:**
- Modify: `src/watch.test.ts` if assertions need tightening

**Step 1: Run targeted tests**

Run: `npm test -- src/watch.test.ts src/web-actions.test.ts`

Expected: PASS

**Step 2: Run broader verification if needed**

Run: `npm test`

Expected: PASS or no regressions in touched areas.
