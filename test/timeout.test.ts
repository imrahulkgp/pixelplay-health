import { describe, it, expect, vi } from "vitest";
import { withTimeout } from "../src/timeout";

describe("withTimeout", () => {
  it("resolves with the underlying value when it settles before the deadline", async () => {
    const r = await withTimeout(() => Promise.resolve("ok"), 1000);
    expect(r).toBe("ok");
  });

  it("propagates a rejection from the underlying promise", async () => {
    const err = new Error("boom");
    await expect(withTimeout(() => Promise.reject(err), 1000)).rejects.toBe(err);
  });

  it("rejects after ms when the underlying promise never settles (e.g. a fetch stuck on DNS)", async () => {
    vi.useFakeTimers();
    const never = () => new Promise(() => {});
    const p = withTimeout(never, 1000);
    const assertion = expect(p).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    vi.useRealTimers();
  });

  it("calls the onTimeout callback when the deadline fires", async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const never = () => new Promise(() => {});
    const p = withTimeout(never, 1000, onTimeout);
    const assertion = expect(p).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(onTimeout).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});
