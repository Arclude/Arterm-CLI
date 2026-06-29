import { describe, expect, it } from "vitest";
import { ArtermUserError } from "./errors.js";
import { isKnownProvider, parsePort, unknownProviderMessage } from "./validate.js";

const KNOWN = ["ollama", "llamacpp", "openai-compat", "anthropic"] as const;

describe("isKnownProvider", () => {
  it("accepts a known id", () => {
    expect(isKnownProvider("ollama", KNOWN)).toBe(true);
  });

  it("rejects an unknown id", () => {
    expect(isKnownProvider("bogus", KNOWN)).toBe(false);
  });

  it("is case-sensitive (no silent normalization)", () => {
    expect(isKnownProvider("Ollama", KNOWN)).toBe(false);
  });
});

describe("unknownProviderMessage", () => {
  it("names the offending id and lists the valid ones", () => {
    const msg = unknownProviderMessage("bogus", KNOWN);
    expect(msg).toContain('"bogus"');
    expect(msg).toContain("ollama");
    expect(msg).toContain("anthropic");
  });
});

describe("parsePort", () => {
  it("returns the fallback when no value is given", () => {
    expect(parsePort(undefined, 7777)).toBe(7777);
  });

  it("parses a valid port", () => {
    expect(parsePort("8080", 7777)).toBe(8080);
  });

  it("rejects out-of-range ports", () => {
    expect(parsePort("0", 7777)).toBeNull();
    expect(parsePort("99999", 7777)).toBeNull();
    expect(parsePort("-1", 7777)).toBeNull();
  });

  it("rejects non-integer / non-numeric values", () => {
    expect(parsePort("abc", 7777)).toBeNull();
    expect(parsePort("80.5", 7777)).toBeNull();
  });
});

describe("ArtermUserError", () => {
  it("carries its message and is an Error", () => {
    const err = new ArtermUserError("boom");
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("boom");
    expect(err.name).toBe("ArtermUserError");
  });
});
