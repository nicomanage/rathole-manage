/// <reference types="@cloudflare/workers-types" />

// PBKDF2-SHA256 password hashing for panel users, using WebCrypto (available in
// the Workers runtime). Salt and iteration count are stored alongside the hash
// so parameters can evolve without invalidating existing users.

import type { User } from "@shared/types";

const encoder = new TextEncoder();
// Cloudflare Workers currently rejects PBKDF2 iteration counts above 100,000.
export const DEFAULT_ITERATIONS = 100_000;
const KEY_BITS = 256;

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    key,
    KEY_BITS,
  );
  return toHex(new Uint8Array(bits));
}

export interface PasswordFields {
  passwordHash: string;
  passwordSalt: string;
  passwordIterations: number;
}

/** Hash a fresh password, generating a new random salt. */
export async function hashPassword(
  password: string,
  iterations = DEFAULT_ITERATIONS,
): Promise<PasswordFields> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const passwordHash = await derive(password, salt, iterations);
  return { passwordHash, passwordSalt: toHex(salt), passwordIterations: iterations };
}

/** Constant-time comparison of two equal-length hex strings. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Verify a candidate password against a stored user's hash. */
export async function verifyPassword(password: string, user: User): Promise<boolean> {
  const candidate = await derive(password, fromHex(user.passwordSalt), user.passwordIterations);
  return timingSafeEqual(candidate, user.passwordHash);
}
