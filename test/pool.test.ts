import { describe, it, expect } from "vitest";
import { pool } from "../src/pool";

describe("pool", () => {
  it("runs every item to completion when there's no deadline", async () => {
    const r = await pool([1, 2, 3], async (n) => n * 2, 2);
    expect(r).toEqual([2, 4, 6]);
  });

  it("never has more than `concurrency` workers in flight at once", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await pool(
      Array.from({ length: 10 }, (_, i) => i),
      async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        inFlight--;
      },
      3,
    );
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  it("stops picking up new items once the deadline passes, leaving the rest undefined", async () => {
    let t = 0;
    const clock = () => t;
    const r = await pool(
      [1, 2, 3, 4, 5],
      async (n) => {
        t += 1; // each item "consumes" one clock tick
        return n * 10;
      },
      1, // single worker -> deterministic processing order
      3, // deadline reached after the 3rd tick
      clock,
    );
    expect(r).toEqual([10, 20, 30, undefined, undefined]);
  });
});
