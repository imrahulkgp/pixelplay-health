import type { Verdict } from "./types";

export const INCONCLUSIVE_TRIPWIRE = 0.5;

export interface Metrics {
  generatedAt: string;
  sampled: number;
  aliveRate: number;
  deadRate: number;
  inconclusiveRate: number;
  segmentFalseAliveRate: number;
  lowConfidence: boolean;
}

export function computeMetrics(
  outcomes: Verdict[],
  segmentChecked: number,
  segmentFalseAlive: number,
  now: Date = new Date(),
): Metrics {
  const n = outcomes.length || 1;
  const count = (v: Verdict) => outcomes.filter((o) => o === v).length;
  const inconclusiveRate = count("INCONCLUSIVE") / n;
  return {
    generatedAt: now.toISOString(),
    sampled: outcomes.length,
    aliveRate: count("ALIVE") / n,
    deadRate: count("DEAD_SIGNAL") / n,
    inconclusiveRate,
    segmentFalseAliveRate: segmentChecked ? segmentFalseAlive / segmentChecked : 0,
    lowConfidence: inconclusiveRate >= INCONCLUSIVE_TRIPWIRE,
  };
}
