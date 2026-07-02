import { describe, it, expect } from "vitest";
import { checkInsecureConfig } from "./config.js";

describe("checkInsecureConfig", () => {
  it("allows 127.0.0.1 with auth=none", () => {
    expect(checkInsecureConfig("127.0.0.1", "none", undefined)).toBeNull();
  });

  it("allows localhost with auth=none", () => {
    expect(checkInsecureConfig("localhost", "none", undefined)).toBeNull();
  });

  it("allows ::1 (IPv6 localhost) with auth=none", () => {
    expect(checkInsecureConfig("::1", "none", undefined)).toBeNull();
  });

  it("allows 0.0.0.0 with auth=bearer", () => {
    expect(checkInsecureConfig("0.0.0.0", "bearer", undefined)).toBeNull();
  });

  it("allows 0.0.0.0 with auth=api-key", () => {
    expect(checkInsecureConfig("0.0.0.0", "api-key", undefined)).toBeNull();
  });

  it("rejects 0.0.0.0 with auth=none without MCAGENT_ALLOW_INSECURE", () => {
    const err = checkInsecureConfig("0.0.0.0", "none", undefined);
    expect(err).not.toBeNull();
    expect(err).toContain("0.0.0.0");
    expect(err).toContain("auth=none");
  });

  it("rejects :: with auth=none without MCAGENT_ALLOW_INSECURE", () => {
    const err = checkInsecureConfig("::", "none", undefined);
    expect(err).not.toBeNull();
    expect(err).toContain("::");
  });

  it("allows 0.0.0.0 with auth=none when MCAGENT_ALLOW_INSECURE=1", () => {
    expect(checkInsecureConfig("0.0.0.0", "none", "1")).toBeNull();
  });

  it("rejects 0.0.0.0 with auth=none when MCAGENT_ALLOW_INSECURE=0", () => {
    // Only exactly "1" is accepted
    const err = checkInsecureConfig("0.0.0.0", "none", "0");
    expect(err).not.toBeNull();
  });

  it("allows 192.168.1.1 (non-wildcard bind) with auth=none", () => {
    expect(checkInsecureConfig("192.168.1.1", "none", undefined)).toBeNull();
  });
});
