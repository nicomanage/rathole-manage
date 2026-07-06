import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./passwords";
import type { User } from "@shared/types";

function userWith(fields: Awaited<ReturnType<typeof hashPassword>>): User {
  return {
    id: "u1",
    username: "alice",
    role: "admin",
    createdAt: 0,
    updatedAt: 0,
    ...fields,
  };
}

describe("password hashing", () => {
  it("verifies a correct password", async () => {
    const fields = await hashPassword("correct horse battery staple");
    const ok = await verifyPassword("correct horse battery staple", userWith(fields));
    expect(ok).toBe(true);
  });

  it("rejects an incorrect password", async () => {
    const fields = await hashPassword("s3cret-password");
    const ok = await verifyPassword("wrong-password", userWith(fields));
    expect(ok).toBe(false);
  });

  it("uses a random salt so identical passwords hash differently", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    expect(a.passwordSalt).not.toBe(b.passwordSalt);
    expect(a.passwordHash).not.toBe(b.passwordHash);
  });
});
