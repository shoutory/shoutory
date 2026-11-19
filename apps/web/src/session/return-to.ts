const HOME = "/";
const BASE = "https://same-origin.invalid";

// A path on this origin: one leading slash, no second slash or backslash right after it, no backslash or control
// character anywhere (a browser strips tabs and newlines, so `/<tab>/host` would become `//host`), and no encoded
// slash or backslash (a later decode would produce the forms above).
const SAME_ORIGIN_PATH = /^\/(?![/\\])[^\\]*$/;
const ENCODED_SEPARATOR = /%(?:2f|5c)/i;
const DELETE = 0x7f;
const SPACE = 0x20;
const hasControlCharacter = (value: string) =>
  [...value].some((char) => (char.codePointAt(0) ?? 0) < SPACE || char.codePointAt(0) === DELETE);

/**
 * Where to go after signing in: the `return-to` value when it is a path on this origin, else the start page. A value
 * that could leave the origin (an absolute URL, `//host`, a backslash or encoded form) is never followed (R378).
 */
export function safeReturnTo(value: string | null): string {
  if (value === null || !SAME_ORIGIN_PATH.test(value)) return HOME;
  if (ENCODED_SEPARATOR.test(value) || hasControlCharacter(value)) return HOME;
  // The URL parser has the last word: whatever it resolves must stay on the base origin.
  return new URL(value, BASE).origin === BASE ? value : HOME;
}
