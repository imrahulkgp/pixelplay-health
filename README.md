# pixelplay-health

A free, scheduled GitHub Action that probes the public [iptv-org](https://github.com/iptv-org/iptv) catalog and publishes a self-healing `dead.json` known-dead channel list to GitHub Pages. Any downstream consumer can read it to deprioritize or hide globally-dead channels.

- **Only globally-fatal signals list a channel** (DNS/refused/TLS/404/410/5xx + HLS first-segment-404). 403/451/429/timeouts are inconclusive and never listed — this sidesteps single-IP geo-blindness.
- **Self-healing:** regenerated each run, keyed by iptv-org channel id, streak `K=2` with instant reset on any alive run and on catalog re-entry. The list is a regenerated snapshot, never an append-only blacklist.
- **Observability + tripwire:** `status.json` carries the alive/dead/inconclusive rates; if `inconclusiveRate >= 0.50` the run keeps the last-good `dead.json` (the probe vantage is degraded).

> [!IMPORTANT]
> **This repo must stay public.** Not a preference: the pipeline stops if it goes private.
>
> GitHub gives public repositories unlimited free Actions minutes. Private repositories on the Free and Pro plans get 2,000 a month. The two schedules here spend roughly **1,720 minutes a month** between them — `probe` takes about 21 minutes daily, and `region-reputation` runs every 15 minutes, ~2,976 times a month. Private, that spends a full month's allowance in about ten days, and the probe stops until the next billing cycle.
>
> It would fail quietly, which is the dangerous part. `dead.json` does not vanish; it goes stale. Consumers honouring the staleness TTL then fail open and show every channel, dead ones included, which is the exact outcome this repo exists to prevent. GitHub Pages on a private repo also needs a paid plan, so the artifacts would stop being served either way.
>
> If it ever has to become private, move both schedules onto compute you pay for first.

## Artifacts (served by GitHub Pages)

- **`dead.json`** — `{ "schemaVersion": 1, "generatedAt": "<ISO8601>", "deadProviderIDs": ["<id>", …] }`. The ids are **raw iptv-org channel ids** (e.g. `cnn.us`) — the same ids iptv-org uses in `streams.json`/`channels.json`. A consumer matches them against its own catalog.
- **`status.json`** — per-run metrics: `{ generatedAt, sampled, aliveRate, deadRate, inconclusiveRate, segmentFalseAliveRate, lowConfidence }`.

## Setup (one-time, manual)

The repo must be **public** (free unlimited Actions minutes + Pages) — see the note above for what breaks otherwise. Create the orphan data branch and enable Pages on it:

```bash
git checkout --orphan data && git rm -rf . && git commit --allow-empty -m init && git push origin data
git checkout main
```

Then in repo Settings → Pages: **source = branch `data`, folder `/ (root)`**. The probe force-pushes `dead.json`/`status.json` to the `data` branch root each run, served at `https://<user>.github.io/pixelplay-health/dead.json`.

## Tuning

`workflow_dispatch` accepts three optional inputs: `concurrency` (`PROBE_CONCURRENCY`, default 40), `timeout` (`PROBE_TIMEOUT_MS` ms, default 10000), and `deadline` (`PROBE_DEADLINE_MS` ms, default 5400000 = 90min — the soft deadline for the probing pool). The daily schedule runs at 03:00 UTC.

## Consumer guidance (not part of this repo)

A consumer should treat the list as advisory and **fail-open**: ignore `dead.json` entirely if `generatedAt` is older than a TTL (e.g. 7 days) so a broken pipeline can never silently bury channels. Matching the raw ids against the consumer's own catalog is the consumer's responsibility.

Design notes: `docs/2026-06-13-channel-health-probe-pipeline-design.md`.
