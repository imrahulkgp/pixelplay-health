import { describe, it, expect } from "vitest";
import type { Verdict } from "../src/types";

describe("toolchain", () => {
  it("compiles TS and runs vitest", () => {
    const v: Verdict = "ALIVE";
    expect(v).toBe("ALIVE");
  });
});
