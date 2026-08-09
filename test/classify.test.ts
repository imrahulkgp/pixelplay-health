import { describe, it, expect } from "vitest";
import { classifyStatus, classifyError, classifyBody, combine, looksLikeSoftError, SOFT_ERROR_MAX_LENGTH } from "../src/classify";

describe("classifyStatus", () => {
  it("hard-dead HTTP", () => {
    expect(classifyStatus(404)).toBe("DEAD_SIGNAL");
    expect(classifyStatus(410)).toBe("DEAD_SIGNAL");
    expect(classifyStatus(500)).toBe("DEAD_SIGNAL");
    expect(classifyStatus(521)).toBe("DEAD_SIGNAL");
  });
  it("geo/rate-limit -> inconclusive", () => {
    for (const s of [403, 451, 456, 429]) expect(classifyStatus(s)).toBe("INCONCLUSIVE");
  });
  it("other non-2xx -> inconclusive", () => {
    expect(classifyStatus(401)).toBe("INCONCLUSIVE");
    expect(classifyStatus(400)).toBe("INCONCLUSIVE");
  });
  it("2xx -> needs body", () => {
    expect(classifyStatus(200)).toBe("CHECK_BODY");
    expect(classifyStatus(206)).toBe("CHECK_BODY");
  });
});

describe("classifyError", () => {
  it("hard-dead network errors", () => {
    expect(classifyError("ENOTFOUND", undefined)).toBe("DEAD_SIGNAL");
    expect(classifyError("ECONNREFUSED", undefined)).toBe("DEAD_SIGNAL");
    expect(classifyError("CERT_HAS_EXPIRED", undefined)).toBe("DEAD_SIGNAL");
    expect(classifyError("DEPTH_ZERO_SELF_SIGNED_CERT", undefined)).toBe("DEAD_SIGNAL"); // pins TLS regex intent
  });
  it("ambiguous -> inconclusive", () => {
    expect(classifyError(undefined, "TimeoutError")).toBe("INCONCLUSIVE");
    expect(classifyError("ECONNRESET", undefined)).toBe("INCONCLUSIVE");
    expect(classifyError("EAI_AGAIN", undefined)).toBe("INCONCLUSIVE");
    expect(classifyError("ETIMEDOUT", undefined)).toBe("INCONCLUSIVE");
  });
});

describe("classifyBody", () => {
  it("non-HLS 2xx is alive", () => {
    expect(classifyBody(false, false, undefined)).toBe("ALIVE");
  });
  it(".m3u8 200 without #EXTM3U is inconclusive (malformed)", () => {
    expect(classifyBody(true, false, undefined)).toBe("INCONCLUSIVE");
  });
  it("HLS manifest + hard-dead segment is DEAD", () => {
    expect(classifyBody(true, true, "dead")).toBe("DEAD_SIGNAL");
  });
  it("HLS manifest + ok/blocked segment is ALIVE", () => {
    expect(classifyBody(true, true, "ok")).toBe("ALIVE");
    expect(classifyBody(true, true, "na")).toBe("ALIVE"); // geo-blocked/unparseable segment, infra is up
  });
  it("a soft error is DEAD whatever the URL extension", () => {
    // The false-ALIVE that mattered: a non-.m3u8 URL answering 200 with an
    // error string used to be reported healthy.
    expect(classifyBody(false, false, undefined, true)).toBe("DEAD_SIGNAL");
    expect(classifyBody(true, false, undefined, true)).toBe("DEAD_SIGNAL");
  });
});

describe("looksLikeSoftError", () => {
  it("catches the body that kept a dead channel in the catalogue", () => {
    // Crime + Investigation Asia: 200 OK, mpegurl content-type, 8 bytes.
    expect(looksLikeSoftError("No route")).toBe(true);
  });

  it("catches the other plain-text excuses CDNs return with a 200", () => {
    for (const body of ["Not Found", "Forbidden", "error", '{"error":"gone"}', "Stream offline"]) {
      expect(looksLikeSoftError(body), body).toBe(true);
    }
  });

  it("never condemns a real playlist", () => {
    expect(looksLikeSoftError("#EXTM3U\n#EXT-X-VERSION:3\n")).toBe(false);
    expect(looksLikeSoftError("#EXT-X-TARGETDURATION:2\n")).toBe(false);
  });

  it("leaves HTML alone, because a block page is about the prober's network", () => {
    // The expensive mistake would be one hostile network marking the whole
    // catalogue dead in a single run.
    expect(looksLikeSoftError("<html><body>Blocked by your ISP</body></html>")).toBe(false);
    expect(looksLikeSoftError('<?xml version="1.0"?><MPD>')).toBe(false);
  });

  it("leaves long bodies alone", () => {
    expect(looksLikeSoftError("x".repeat(SOFT_ERROR_MAX_LENGTH + 1))).toBe(false);
  });

  it("leaves binary and empty bodies alone", () => {
    expect(looksLikeSoftError("")).toBe(false);
    expect(looksLikeSoftError("   \n  ")).toBe(false);
    expect(looksLikeSoftError("\x47\x40\x11\x10\u00c1\u00ff")).toBe(false);
  });
});

describe("combine (alive > inconclusive > dead)", () => {
  it("any alive wins", () => expect(combine(["DEAD_SIGNAL", "ALIVE"])).toBe("ALIVE"));
  it("404+403 -> inconclusive", () => expect(combine(["DEAD_SIGNAL", "INCONCLUSIVE"])).toBe("INCONCLUSIVE"));
  it("all dead -> dead", () => expect(combine(["DEAD_SIGNAL", "DEAD_SIGNAL"])).toBe("DEAD_SIGNAL"));
  it("empty -> inconclusive (fail safe; never a false-dead)", () => expect(combine([])).toBe("INCONCLUSIVE"));
});
