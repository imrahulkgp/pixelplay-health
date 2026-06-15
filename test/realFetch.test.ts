import { describe, it, expect, vi } from "vitest";
import { createRealFetch } from "../src/realFetch";

describe("createRealFetch", () => {
  it("resolves status/url and reads the body when both settle promptly", async () => {
    const rawFetch = async () => ({ status: 200, url: "https://h/a", text: async () => "body" });
    const f = createRealFetch(1000, rawFetch);
    const resp = await f("https://h/a");
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("body");
  });

  it("bounds the initial fetch even if it never resolves (e.g. stuck DNS)", async () => {
    vi.useFakeTimers();
    const rawFetch = (): Promise<never> => new Promise(() => {});
    const f = createRealFetch(1000, rawFetch);
    const p = f("https://h/a");
    const assertion = expect(p).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    vi.useRealTimers();
  });

  it("bounds resp.text() even if the body stream never resolves (e.g. a stalled connection)", async () => {
    vi.useFakeTimers();
    const rawFetch = async () => ({ status: 200, url: "https://h/a", text: (): Promise<string> => new Promise(() => {}) });
    const f = createRealFetch(1000, rawFetch);
    const resp = await f("https://h/a");
    const assertion = expect(resp.text()).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    vi.useRealTimers();
  });
});
