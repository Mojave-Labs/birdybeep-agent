import { describe, expect, it, vi } from "vitest";

import { certificateFailure, configureSystemTrust } from "./network";

describe("system certificate trust", () => {
  it("adds system roots while retaining default and extra roots", () => {
    const setDefaultCACertificates = vi.fn();
    expect(
      configureSystemTrust({
        getCACertificates: (type) =>
          type === "system" ? ["company-root", "public-root"] : ["public-root", "extra-root"],
        setDefaultCACertificates,
      }),
    ).toBe(true);
    expect(setDefaultCACertificates).toHaveBeenCalledWith([
      "public-root",
      "extra-root",
      "company-root",
    ]);
  });

  it("keeps older supported Node releases working without the new TLS APIs", () => {
    expect(configureSystemTrust({})).toBe(false);
  });

  it("retains existing trust if the system store cannot be read", () => {
    const setDefaultCACertificates = vi.fn();
    expect(
      configureSystemTrust({
        getCACertificates: () => {
          throw new Error("system store unavailable");
        },
        setDefaultCACertificates,
      }),
    ).toBe(false);
    expect(setDefaultCACertificates).not.toHaveBeenCalled();
  });
});

describe("certificate failure diagnosis", () => {
  it("finds the TLS cause hidden by fetch without printing arbitrary error text", () => {
    const cause = Object.assign(new Error("private proxy URL and credentials"), {
      code: "SELF_SIGNED_CERT_IN_CHAIN",
    });
    const failure = certificateFailure(new TypeError("fetch failed", { cause }));
    expect(failure?.detail).toContain("SELF_SIGNED_CERT_IN_CHAIN");
    expect(failure?.detail).not.toContain("private proxy");
    expect(failure?.remedy).toContain("system trust store");
    expect(failure?.remedy).toContain("NODE_EXTRA_CA_CERTS");
  });

  it("diagnoses hostname and expiry failures without suggesting additional trust", () => {
    for (const code of ["ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED"]) {
      const failure = certificateFailure({ code });
      expect(failure?.detail).toContain(code);
      expect(failure?.remedy).not.toContain("NODE_EXTRA_CA_CERTS");
    }
  });

  it("does not mislabel network or unknown failures", () => {
    expect(certificateFailure({ code: "ECONNREFUSED" })).toBeUndefined();
    expect(certificateFailure(new Error("fetch failed"))).toBeUndefined();
    expect(certificateFailure(null)).toBeUndefined();
  });

  it("handles aggregate causes and cyclic error chains", () => {
    expect(
      certificateFailure(new AggregateError([{ code: "DEPTH_ZERO_SELF_SIGNED_CERT" }])),
    ).toBeDefined();
    const cyclic: { cause?: unknown } = {};
    cyclic.cause = cyclic;
    expect(certificateFailure(cyclic)).toBeUndefined();
  });
});
