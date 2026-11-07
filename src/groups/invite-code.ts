import { randomBytes } from "node:crypto";

/** Crockford base32: no I, L, O or U, so codes are easy to read aloud. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const INVITE_CODE_LENGTH = 10;

export function generateInviteCode(): string {
  const bytes = randomBytes(INVITE_CODE_LENGTH);
  let code = "";
  for (const byte of bytes) code += ALPHABET[byte % ALPHABET.length];
  return code;
}

/** Case-insensitive; removes separators and maps common look-alikes. */
export function normalizeInviteCode(value: string): string {
  return value
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0")
    .replace(/U/g, "V");
}

export function looksLikeInviteCode(value: string): boolean {
  const code = normalizeInviteCode(value);
  return (
    code.length === INVITE_CODE_LENGTH &&
    [...code].every((character) => ALPHABET.includes(character))
  );
}

export function formatInviteCode(code: string): string {
  const normalized = normalizeInviteCode(code);
  return `${normalized.slice(0, 5)}-${normalized.slice(5)}`;
}
