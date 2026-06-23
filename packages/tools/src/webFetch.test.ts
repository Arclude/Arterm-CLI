import { describe, expect, it } from "vitest";
import { assertSafeUrl, isBlockedAddress } from "./webFetch.js";

describe("isBlockedAddress", () => {
  it("blocks loopback, private, link-local, CGNAT, and this-host ranges", () => {
    const blocked = [
      "127.0.0.1",
      "::1",
      "10.0.0.5",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.1.1",
      "0.0.0.0",
      "::ffff:127.0.0.1",
      "fe80::1",
      "fc00::1",
      "100.64.0.1",
    ];
    for (const ip of blocked) {
      expect(isBlockedAddress(ip), `${ip} should be blocked`).toBe(true);
    }
  });

  it("allows public addresses", () => {
    const allowed = ["1.1.1.1", "8.8.8.8", "93.184.216.34"];
    for (const ip of allowed) {
      expect(isBlockedAddress(ip), `${ip} should be allowed`).toBe(false);
    }
  });
});

describe("assertSafeUrl", () => {
  it("rejects non-http(s) protocols", async () => {
    await expect(assertSafeUrl("file:///etc/passwd")).rejects.toThrow();
    await expect(assertSafeUrl("ftp://example.com/x")).rejects.toThrow();
  });

  it("rejects blocked IP literals without touching the network", async () => {
    await expect(assertSafeUrl("http://127.0.0.1/")).rejects.toThrow();
    await expect(assertSafeUrl("http://169.254.169.254/latest/meta-data")).rejects.toThrow();
    await expect(assertSafeUrl("http://[::1]/")).rejects.toThrow();
  });

  it("returns a URL for a safe public IP literal", async () => {
    const url = await assertSafeUrl("https://1.1.1.1/");
    expect(url.protocol).toBe("https:");
    expect(url.hostname).toBe("1.1.1.1");
  });
});
