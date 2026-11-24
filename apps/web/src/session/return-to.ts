const HOME = "/";
const BASE = "https://same-origin.invalid";

// A browser strips tabs and newlines, so `/<tab>/host` would become `//host`; an encoded slash or backslash would
// decode into the same forms.
const SAME_ORIGIN_PATH = /^\/(?![/\\])[^\\]*$/;
const ENCODED_SEPARATOR = /%(?:2f|5c)/i;
const DELETE = 0x7f;
const SPACE = 0x20;
const hasControlCharacter = (value: string) =>
  [...value].some((char) => (char.codePointAt(0) ?? 0) < SPACE || char.codePointAt(0) === DELETE);

export function safeReturnTo(value: string | null): string {
  if (value === null || !SAME_ORIGIN_PATH.test(value)) return HOME;
  if (ENCODED_SEPARATOR.test(value) || hasControlCharacter(value)) return HOME;
  // Last check: whatever the URL parser resolves must stay on the base origin.
  return new URL(value, BASE).origin === BASE ? value : HOME;
}
