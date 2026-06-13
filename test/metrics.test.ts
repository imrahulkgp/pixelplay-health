import { describe, it, expect } from "vitest";
import { computeMetrics, INCONCLUSIVE_TRIPWIRE } from "../src/metrics";

describe("computeMetrics", () => {
  it("computes rates and segmentFalseAliveRate", () => {
    const m = computeMetrics(
      ["ALIVE", "ALIVE", "DEAD_SIGNAL", "INCONCLUSIVE"],
      10, // segmentChecked
      1, // segmentFalseAlive
    );
    expect(m.sampled).toBe(4);
    expect(m.aliveRate).toBeCloseTo(0.5);
    expect(m.deadRate).toBeCloseTo(0.25);
    expect(m.inconclusiveRate).toBeCloseTo(0.25);
    expect(m.segmentFalseAliveRate).toBeCloseTo(0.1);
    expect(m.lowConfidence).toBe(false);
  });
  it("trips low-confidence at the inconclusive tripwire", () => {
    const half = Array(50).fill("INCONCLUSIVE").concat(Array(50).fill("ALIVE"));
    const m = computeMetrics(half as any, 0, 0);
    expect(m.inconclusiveRate).toBeGreaterThanOrEqual(INCONCLUSIVE_TRIPWIRE);
    expect(m.lowConfidence).toBe(true);
  });
});
