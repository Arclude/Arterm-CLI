import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ARTERM_HOME } from "./config.js";

/**
 * Encrypted-at-rest storage for provider API keys (AES-256-GCM). Secrets live in
 * `~/.arterm/secrets.json` as authenticated ciphertext; the 32-byte master key is
 * derived from the `ARTERM_SECRET` env var (scrypt) when set, otherwise read from
 * a generated `~/.arterm/key` file (0600). This keeps keys out of plaintext config
 * and out of anything that might be shared or committed.
 */

const ALGORITHM = "aes-256-gcm";
const KEY_DERIVATION_SALT = "arterm-keystore-v1";

export interface SecretBlob {
  /** base64 IV (12 bytes). */
  iv: string;
  /** base64 GCM auth tag. */
  tag: string;
  /** base64 ciphertext. */
  data: string;
}

/** Encrypt a UTF-8 string with AES-256-GCM under a 32-byte key. */
export function encryptSecret(plaintext: string, key: Buffer): SecretBlob {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

/** Decrypt a SecretBlob; throws if the key is wrong or the data was tampered with. */
export function decryptSecret(blob: SecretBlob, key: Buffer): string {
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(blob.iv, "base64"));
  decipher.setAuthTag(Buffer.from(blob.tag, "base64"));
  const out = Buffer.concat([decipher.update(Buffer.from(blob.data, "base64")), decipher.final()]);
  return out.toString("utf8");
}

function loadMasterKey(dir: string): Buffer {
  const passphrase = process.env.ARTERM_SECRET;
  if (passphrase) return scryptSync(passphrase, KEY_DERIVATION_SALT, 32);

  const keyPath = join(dir, "key");
  if (existsSync(keyPath)) {
    const existing = Buffer.from(readFileSync(keyPath, "utf8").trim(), "base64");
    if (existing.length === 32) return existing;
  }
  mkdirSync(dir, { recursive: true });
  const key = randomBytes(32);
  writeFileSync(keyPath, key.toString("base64"), { mode: 0o600 });
  try {
    chmodSync(keyPath, 0o600);
  } catch {
    // chmod is a no-op on some platforms (e.g. Windows); ignore.
  }
  return key;
}

/** Reads and writes AES-256-GCM-encrypted secrets keyed by name. */
export class Keystore {
  private constructor(
    private readonly dir: string,
    private readonly key: Buffer,
    private readonly secrets: Record<string, SecretBlob>,
  ) {}

  /** Open (or initialize) the keystore under `dir` (default ~/.arterm). */
  static open(dir: string = ARTERM_HOME): Keystore {
    const key = loadMasterKey(dir);
    let secrets: Record<string, SecretBlob> = {};
    try {
      secrets = JSON.parse(readFileSync(join(dir, "secrets.json"), "utf8")) as Record<
        string,
        SecretBlob
      >;
    } catch {
      // No secrets file yet, or unreadable — start empty.
    }
    return new Keystore(dir, key, secrets);
  }

  /** Decrypt and return a stored secret, or undefined if absent/undecryptable. */
  get(name: string): string | undefined {
    const blob = this.secrets[name];
    if (!blob) return undefined;
    try {
      return decryptSecret(blob, this.key);
    } catch {
      return undefined;
    }
  }

  /** Encrypt and persist a secret. */
  set(name: string, secret: string): void {
    this.secrets[name] = encryptSecret(secret, this.key);
    this.save();
  }

  /** Remove a secret; returns whether it existed. */
  remove(name: string): boolean {
    if (!(name in this.secrets)) return false;
    delete this.secrets[name];
    this.save();
    return true;
  }

  /** Names of stored secrets (never the values). */
  names(): string[] {
    return Object.keys(this.secrets).sort();
  }

  private save(): void {
    mkdirSync(this.dir, { recursive: true });
    const path = join(this.dir, "secrets.json");
    writeFileSync(path, `${JSON.stringify(this.secrets, null, 2)}\n`, { mode: 0o600 });
    try {
      chmodSync(path, 0o600);
    } catch {
      // ignore on platforms without POSIX perms
    }
  }
}
