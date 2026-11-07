import { describe, expect, it } from "vitest";
import {
  formatInviteCode,
  generateInviteCode,
  looksLikeInviteCode,
  normalizeInviteCode,
} from "../src/groups/invite-code.js";

describe("invite codes", () => {
  it("generates readable ten-character Crockford codes", () => {
    const code = generateInviteCode();
    expect(code).toHaveLength(10);
    expect(code).not.toMatch(/[ILOU]/);
    expect(looksLikeInviteCode(code)).toBe(true);
  });

  it("normalizes case, separators and look-alike characters", () => {
    expect(normalizeInviteCode("abcde-fghjk")).toBe("ABCDEFGHJK");
    expect(normalizeInviteCode("I L O U")).toBe("110V");
    expect(normalizeInviteCode("abcde fghjk")).toBe("ABCDEFGHJK");
  });

  it("formats codes in two groups of five", () => {
    expect(formatInviteCode("abcdefghjk")).toBe("ABCDE-FGHJK");
    expect(looksLikeInviteCode("ABCDE-FGHJK")).toBe(true);
    expect(looksLikeInviteCode("not-an-invite")).toBe(false);
  });
});
