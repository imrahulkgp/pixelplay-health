# Probe Deadline Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the daily probe run reliably cover the full ~8,657-channel catalog in a single run, so `dead.json` is deterministically complete instead of probabilistically complete across many days.

**Architecture:** Three small, independent config/doc edits — raise the pool's soft deadline default in `src/run.ts`, stop the workflow's concurrency group from cancelling overlapping runs (queue instead) and fix its stale input description in `.github/workflows/probe.yml`, and bring `README.md`'s Tuning section in sync with the workflow's actual inputs. No new modules, no probe-logic changes.

**Tech Stack:** Node 20 + TypeScript via `tsx` (no build step) + vitest; GitHub Actions workflow YAML.

## Global Constraints

- Repo root for every command/path below: `/Users/rahulgupta/Documents/PixelPlay/pixelplay-health`
- No new tests: per the spec (`docs/superpowers/specs/2026-07-04-probe-deadline-fix-design.md`), no existing test asserts the old 15-min default or the `cancel-in-progress` semantics (`test/integration.test.ts:76` passes an explicit `deadlineMs: 3` override) — verification is "the existing suite stays green," not new test authorship.
- Do not modify `src/pool.ts`, `src/streak.ts`, `src/catalog.ts`, `src/probe.ts`, or any other probe logic — out of scope per spec.
- Do not address the undrained-response-body finding raised in the independent audit (non-`CHECK_BODY` responses not draining their body in `probe.ts`) — pre-existing, explicitly deferred, not part of this fix.
- Do not push to GitHub or trigger the Action — that's the user's call once the local commits look right, same as the manual-flip steps in the rest of this repo's history.

---

### Task 1: Raise the pool's default soft deadline

**Files:**
- Modify: `src/run.ts:16-24`

**Interfaces:** none — `DEADLINE_MS` is an unexported module-level constant with no consumers outside this file (the only override path is `RunProbeOptions.deadlineMs`, already parameterized and untouched).

- [ ] **Step 1: Replace the comment block and constant**

Current (`src/run.ts:16-24`):
```ts
// Soft deadline for the probing pool itself. Observed: at concurrency 40 the pool covers
// ~8600 channels in ~24min, and the GH-hosted runner has twice been killed by a
// "received a shutdown signal" cancellation at ~28-30min -- with nothing written yet.
// 15min caps the pool well inside that budget, leaving headroom for catalog fetch,
// writing status/dead/state.json, and the data-branch publish step. Channels not
// reached this run keep their prevState (graceful degradation); `shuffle` below spreads
// the carried-forward channels across runs so coverage isn't permanently stuck on a
// catalog-order suffix.
const DEADLINE_MS = Number(process.env.PROBE_DEADLINE_MS) || 15 * 60 * 1000;
```

Replace with:
```ts
// Soft deadline for the probing pool itself. At concurrency 40 the pool covers the full
// ~8600-channel catalog in ~24-30min in the common case. The historical "received a
// shutdown signal" kills at ~28-30min were traced to this workflow's `cancel-in-progress:
// true` concurrency group cancelling an in-flight run whenever an overlapping trigger (e.g.
// a manual workflow_dispatch during tuning) landed -- not a real platform ceiling (the job's
// own `timeout-minutes: 120` in probe.yml was never the actual constraint). Now that
// overlapping triggers queue instead of cancelling, 90min gives ~3x margin over the common
// case (covers a materially slower day) while leaving ~30min of the job's 120min budget for
// catalog fetch, file writes, and the data-branch publish step. Channels not reached this
// run keep their prevState (graceful degradation); `shuffle` below spreads the
// carried-forward channels across runs so coverage isn't permanently stuck on a
// catalog-order suffix.
const DEADLINE_MS = Number(process.env.PROBE_DEADLINE_MS) || 90 * 60 * 1000;
```

- [ ] **Step 2: Run the existing suite to confirm nothing depended on the old default**

Run: `npm test`
Expected: every test file passes, zero failures.

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no output, exit code 0.

- [ ] **Step 4: Commit**

```bash
git add src/run.ts
git commit -m "Raise probe deadline to 90min now that overlapping runs queue instead of cancel"
```

---

### Task 2: Stop overlapping runs from cancelling each other, fix the stale input description and env-comment

**Files:**
- Modify: `.github/workflows/probe.yml:16`, `.github/workflows/probe.yml:21`, `.github/workflows/probe.yml:48`

**Interfaces:** none — pure YAML config.

- [ ] **Step 1: Update the `deadline` input description and flip `cancel-in-progress`**

Current (`.github/workflows/probe.yml:15-21`):
```yaml
      deadline:
        description: "PROBE_DEADLINE_MS soft deadline for the probing pool (blank = default 900000 = 15min)"
        required: false
        default: ""
concurrency:
  group: probe
  cancel-in-progress: true
```

Replace with:
```yaml
      deadline:
        description: "PROBE_DEADLINE_MS soft deadline for the probing pool (blank = default 5400000 = 90min)"
        required: false
        default: ""
concurrency:
  group: probe
  cancel-in-progress: false
```

(Only the `deadline` description's default value and the `cancel-in-progress` value change; every surrounding line — including the sibling `concurrency`/`timeout` inputs and the `group: probe` line — stays exactly as-is.)

- [ ] **Step 2: Update the matching env-comment further down in the same file**

`probe.yml:48` documents the same fallback value in a comment next to where the env var is actually wired up — this is a separate line from Step 1's edit and must be updated too, or it'll contradict the input description right above it.

Current (`.github/workflows/probe.yml:45-48`):
```yaml
        env:
          PROBE_CONCURRENCY: ${{ inputs.concurrency }}   # blank on schedule -> Number("")||40 = 40
          PROBE_TIMEOUT_MS: ${{ inputs.timeout }}         # blank on schedule -> Number("")||10000 = 10s
          PROBE_DEADLINE_MS: ${{ inputs.deadline }}       # blank on schedule -> Number("")||900000 = 15min
```

Replace with:
```yaml
        env:
          PROBE_CONCURRENCY: ${{ inputs.concurrency }}   # blank on schedule -> Number("")||40 = 40
          PROBE_TIMEOUT_MS: ${{ inputs.timeout }}         # blank on schedule -> Number("")||10000 = 10s
          PROBE_DEADLINE_MS: ${{ inputs.deadline }}       # blank on schedule -> Number("")||5400000 = 90min
```

(Only the last line's trailing comment changes; the two `PROBE_CONCURRENCY`/`PROBE_TIMEOUT_MS` lines stay exactly as-is.)

- [ ] **Step 3: Validate YAML syntax**

Run: `ruby -ryaml -e "YAML.load_file('.github/workflows/probe.yml'); puts 'ok'"`
Expected: `ok`

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/probe.yml
git commit -m "Queue overlapping probe runs instead of cancelling them"
```

---

### Task 3: Sync README's Tuning section with the workflow's three inputs

**Files:**
- Modify: `README.md:25-27`

**Interfaces:** none — documentation only.

- [ ] **Step 1: Update the Tuning section**

Current (`README.md:25-27`):
```markdown
## Tuning

`workflow_dispatch` accepts two optional inputs: `concurrency` (`PROBE_CONCURRENCY`, default 40) and `timeout` (`PROBE_TIMEOUT_MS` ms, default 10000). The daily schedule runs at 03:00 UTC.
```

Replace with:
```markdown
## Tuning

`workflow_dispatch` accepts three optional inputs: `concurrency` (`PROBE_CONCURRENCY`, default 40), `timeout` (`PROBE_TIMEOUT_MS` ms, default 10000), and `deadline` (`PROBE_DEADLINE_MS` ms, default 5400000 = 90min — the soft deadline for the probing pool). The daily schedule runs at 03:00 UTC.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "Document the deadline input in the Tuning section"
```

---

### Task 4: Final consistency sweep (verification only, no code changes expected)

**Files:** none (repo-wide check)

- [ ] **Step 1: Grep for any remaining stale 15-min references**

`--exclude-dir=docs` is required here, not optional: `docs/superpowers/specs/2026-07-04-probe-deadline-fix-design.md` and this plan file itself both quote "900000 = 15min" verbatim when describing the *old* behavior for context — those are intentional historical references, not stale code, and grepping them in would make "no output" impossible to satisfy and could lead to wrongly editing the spec/plan.

Run: `grep -rn "900000\|15 \* 60\|15min" --include="*.ts" --include="*.yml" --include="*.md" . --exclude-dir=node_modules --exclude-dir=docs`
Expected: no output (empty — every live reference to the old default in `src/`, `.github/`, and `README.md` was updated by Tasks 1-3).

- [ ] **Step 2: Run the full suite one more time**

Run: `npm test`
Expected: all tests pass, zero failures.

- [ ] **Step 3: No commit** — this task makes no file changes; it only confirms Tasks 1-3 left the repo internally consistent. If either check above surfaces something, fix it as part of the task whose file it belongs to (Task 1, 2, or 3), re-run this sweep, and only then consider the plan done.

---

## Manual follow-up (user, not part of this plan)

Everything above is local-only (edits + local test/type-check/YAML-parse runs). Two items from the spec's Verification section require pushing these commits to GitHub and triggering the Action, which is the user's call, not something an implementing engineer does as part of this plan:

- Trigger a `workflow_dispatch` (or wait for the next `03:00 UTC` cron) and confirm `status.json`'s metrics show all ~8,657 channels probed, with no "soft deadline reached" log line (`src/run.ts:97`).
- Fire a manual `workflow_dispatch` while a run is mid-flight and confirm it queues (visible in the Actions run list) rather than cancelling the in-flight run.
