# Probe deadline fix — single-run full-catalog coverage

## Problem

The daily probe run is soft-capped at 15 minutes (`PROBE_DEADLINE_MS`, `src/run.ts:24`), even though the pool covers the full ~8,657-channel catalog in ~24-30 min at the default concurrency (40). Channels not reached before the cap carry forward their previous state (graceful degradation — see `run.ts:85`), and `shuffle()` spreads the carried-forward channels across runs so coverage isn't stuck on a catalog-order suffix. In practice this means the dead-channel list is only ever probabilistically complete across several days of runs, not deterministically complete from any single run.

## Root cause

The 15-minute cap was added defensively after two observed "received a shutdown signal" job cancellations at ~28-30 min. That message is what GitHub Actions emits for an **explicit cancellation**, not a `timeout-minutes` expiry — and the workflow already has:

```yaml
concurrency:
  group: probe
  cancel-in-progress: true
```

(`probe.yml:19-21`). This cancels any in-flight run the instant a new trigger lands in the same group — e.g. a manual `workflow_dispatch` fired during concurrency tuning while the scheduled run was still going. The original pipeline design doc's stated target was always "~30 min per run, well within the 6h Action limit" (`docs/2026-06-13-channel-health-probe-pipeline-design.md:21,132,167`). The 15-minute cap overcorrected for a self-inflicted cancellation rather than a real platform ceiling, and turned a solvable overlap problem into a permanent coverage gap.

## Fix

Config-only change, no new architecture:

1. **`src/run.ts:24`** — raise the default `DEADLINE_MS` from 15 min to **90 min**. This is ~3x the observed ~25-30min full-catalog time, chosen to also cover a materially slower day (e.g. elevated timeout rates) with margin, while staying under the job's existing `timeout-minutes: 120` (leaving ~30 min headroom for catalog fetch, file writes, and the data-branch publish step). The comment block directly above it (`run.ts:16-23`), which justifies 15 min via the shutdown-signal kills, is now stale reasoning and must be rewritten alongside the constant — not just the number changed.
2. **`.github/workflows/probe.yml:21`** — `cancel-in-progress: true` → `false`. The concurrency group still guarantees only one probe run ever writes to the `data` branch at a time (an overlapping trigger queues behind the running job instead of racing it) — but it no longer kills an in-flight run and discards its progress. This removes the actual cause of the historical 28-30 min kills.
3. **`.github/workflows/probe.yml:16`** — update the `workflow_dispatch` `deadline` input's description text (currently says "default 900000 = 15min") to match the new default.
4. **`README.md`** Tuning section — it currently documents only the `concurrency` and `timeout` inputs and omits `deadline` entirely, and its lead-in sentence explicitly says "accepts **two** optional inputs" (`README.md:27`). Add the `deadline` input (`PROBE_DEADLINE_MS`, new default 90min) and reword the sentence to reflect three.

## Out of scope

- No changes to `pool.ts`, `streak.ts`, `catalog.ts`, or any probe logic — the pool already handles a deadline cutoff gracefully (carries forward `prevState` for unreached channels), this fix just makes hitting that cutoff a rare event instead of the nightly norm.
- No multi-run batching/hand-off architecture (chaining separate workflow runs, cross-run state hand-off via a triggered follow-up dispatch). Considered and explicitly rejected in favor of this simpler fix: a single run already fits the full catalog inside the existing job timeout once the deadline and cancellation-on-overlap issues are corrected, so there's no coverage gap left for batching to solve.
- No change to `timeout-minutes: 120` on the job itself — 90 min pool deadline plus fetch/publish overhead comfortably fits inside it.
- No test changes expected: no existing test asserts the default `DEADLINE_MS` value (the one deadline-related test, `test/integration.test.ts:76`, passes an explicit `deadlineMs: 3` override).
- An independent audit flagged that non-`CHECK_BODY` responses (e.g. 5xx) in `probe.ts` never drain their response body, which can block HTTP keep-alive connection reuse under undici — a run over the full catalog roughly doubles total request volume versus today's capped runs, so this pre-existing issue gets more exposure. It predates this fix and isn't required for the deadline/cancellation fix to be correct; left out of scope here and worth a separate follow-up.

## Verification

- `npm test` still green (no test depends on the old default).
- `npm run probe` (or a manual `workflow_dispatch`) completes a full run and `status.json`'s per-run metrics show all ~8,657 channels probed (no "soft deadline reached" log line from `run.ts:97`).
- A manual `workflow_dispatch` fired while the scheduled run is mid-flight queues instead of cancelling it (observable via the Actions run queue, not a "shutdown signal" cancellation in the logs).
