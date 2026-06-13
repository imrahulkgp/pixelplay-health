import type { Verdict, ChannelState, StateMap } from "./types";

export const K = 2; // consecutive DEAD_SIGNAL runs to list
export const CADENCE_MS = 24 * 60 * 60 * 1000; // daily
export const PRUNE_DAYS = 30;

export function updateChannel(
  prev: ChannelState | undefined,
  verdict: Verdict,
  now: Date,
  cadenceMs: number = CADENCE_MS,
): ChannelState {
  const nowISO = now.toISOString();
  let failStreak = prev?.failStreak ?? 0;
  // Re-entry-after-absence reset: stale lastSeen means it was gone; evaluate fresh.
  if (prev && now.getTime() - new Date(prev.lastSeen).getTime() > 2 * cadenceMs) {
    failStreak = 0;
  }
  if (verdict === "ALIVE") failStreak = 0;
  else if (verdict === "DEAD_SIGNAL") failStreak += 1;
  // INCONCLUSIVE: unchanged
  return { failStreak, lastChecked: nowISO, lastSeen: nowISO };
}

export function isDead(s: ChannelState, k: number = K): boolean {
  return s.failStreak >= k;
}

export function prune(state: StateMap, now: Date, days: number = PRUNE_DAYS): StateMap {
  const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
  const out: StateMap = {};
  for (const [id, s] of Object.entries(state)) {
    if (new Date(s.lastSeen).getTime() >= cutoff) out[id] = s;
  }
  return out;
}
