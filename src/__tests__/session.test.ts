/**
 * Phase 4 auth primitives — session tokens, magic links, password hashing.
 * All stateless (no DB/Redis), so tested directly.
 */
import { describe, it, expect } from "vitest";
import { createToken, verifyToken } from "@/lib/session";
import { buildMagicLink, verifyMagicLink } from "@/lib/magic-link";
import { hashPassword, verifyPassword } from "@/lib/password";

describe("session tokens", () => {
  it("round-trips a valid payload", () => {
    const token = createToken({ role: "ADMIN", userId: "user_1" }, 3600);
    const payload = verifyToken(token);
    expect(payload).toMatchObject({ role: "ADMIN", userId: "user_1" });
  });

  it("rejects a tampered token", () => {
    const token = createToken({ role: "ADMIN", userId: "user_1" }, 3600);
    const tampered = token.slice(0, -2) + "xx";
    expect(verifyToken(tampered)).toBeNull();
  });

  it("rejects an expired token", () => {
    const token = createToken({ role: "SELLER", partyId: "party_1" }, -10);
    expect(verifyToken(token)).toBeNull();
  });

  it("rejects garbage input without throwing", () => {
    expect(verifyToken("not-a-token")).toBeNull();
    expect(verifyToken("")).toBeNull();
  });
});

describe("magic links", () => {
  it("builds a URL under /dashboard/magic with a verifiable token", () => {
    const link = buildMagicLink("party_42", "SELLER");
    const url = new URL(link);
    expect(url.pathname).toBe("/dashboard/magic");

    const token = url.searchParams.get("token")!;
    const redeemed = verifyMagicLink(token);
    expect(redeemed).toEqual({ partyId: "party_42", role: "SELLER" });
  });

  it("returns null for a garbage token", () => {
    expect(verifyMagicLink("garbage")).toBeNull();
  });

  it("a session token (no partyId) is not a valid magic link", () => {
    const token = createToken({ role: "ADMIN", userId: "user_1" }, 3600);
    expect(verifyMagicLink(token)).toBeNull();
  });
});

describe("password hashing", () => {
  it("verifies the correct password and rejects a wrong one", () => {
    const stored = hashPassword("correct horse battery staple");
    expect(verifyPassword("correct horse battery staple", stored)).toBe(true);
    expect(verifyPassword("wrong password", stored)).toBe(false);
  });

  it("produces a different hash each time (random salt)", () => {
    const a = hashPassword("same-password");
    const b = hashPassword("same-password");
    expect(a).not.toBe(b);
  });

  it("never throws on malformed stored hashes", () => {
    expect(verifyPassword("anything", "not-a-valid-hash")).toBe(false);
    expect(verifyPassword("anything", "")).toBe(false);
  });
});
