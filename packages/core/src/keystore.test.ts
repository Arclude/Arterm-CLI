import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Keystore, decryptSecret, encryptSecret } from "./keystore.js";

describe("encryptSecret / decryptSecret", () => {
  const key = randomBytes(32);

  it("round-trips a secret", () => {
    const blob = encryptSecret("sk-test-12345", key);
    expect(blob.data).not.toContain("sk-test"); // ciphertext, not plaintext
    expect(decryptSecret(blob, key)).toBe("sk-test-12345");
  });

  it("uses a fresh IV each time (different ciphertext for same input)", () => {
    expect(encryptSecret("x", key).iv).not.toBe(encryptSecret("x", key).iv);
  });

  it("throws when the key is wrong", () => {
    const blob = encryptSecret("secret", key);
    expect(() => decryptSecret(blob, randomBytes(32))).toThrow();
  });

  it("throws when the ciphertext is tampered with", () => {
    const blob = encryptSecret("secret", key);
    const flipped = Buffer.from(blob.data, "base64");
    flipped[0] = (flipped[0] ?? 0) ^ 0xff;
    expect(() => decryptSecret({ ...blob, data: flipped.toString("base64") }, key)).toThrow();
  });
});

describe("Keystore", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "arterm-keys-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("stores, reads, lists, and removes secrets", () => {
    const ks = Keystore.open(dir);
    ks.set("openai", "sk-abc");
    ks.set("anthropic", "sk-ant");
    expect(ks.get("openai")).toBe("sk-abc");
    expect(ks.names()).toEqual(["anthropic", "openai"]);
    expect(ks.remove("openai")).toBe(true);
    expect(ks.get("openai")).toBeUndefined();
    expect(ks.remove("openai")).toBe(false);
  });

  it("persists encrypted secrets across reopen (same key file)", () => {
    Keystore.open(dir).set("openai", "sk-persist");
    expect(Keystore.open(dir).get("openai")).toBe("sk-persist");
  });

  it("writes ciphertext to disk, not the plaintext secret", async () => {
    Keystore.open(dir).set("openai", "sk-plaintext-should-not-appear");
    const raw = await fs.readFile(join(dir, "secrets.json"), "utf8");
    expect(raw).not.toContain("sk-plaintext-should-not-appear");
  });

  it("returns undefined for an unknown name", () => {
    expect(Keystore.open(dir).get("missing")).toBeUndefined();
  });
});
