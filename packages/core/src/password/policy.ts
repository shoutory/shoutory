import { z } from "zod";
import { COMMON_PASSWORDS } from "./common-passwords.js";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "./limits.js";

const LENGTH_MESSAGE = "The password must be 15 to 128 characters.";

const codePoints = (value: string): number => [...value].length;

// Digits, symbols and spaces around the letters are what people add to a common word ("password1!").
const NOT_LETTERS_AT_EDGES = /^[^\p{L}]+|[^\p{L}]+$/gu;

function repeatsAnEntry(word: string): boolean {
  if (COMMON_PASSWORDS.has(word)) return true;
  for (let size = 1; size <= word.length / 2; size++) {
    const unit = word.slice(0, size);
    if (word.length % size === 0 && COMMON_PASSWORDS.has(unit) && unit.repeat(word.length / size) === word) {
      return true;
    }
  }
  return false;
}

export function isCommonPassword(password: string): boolean {
  const lowered = password.normalize("NFKC").toLowerCase();
  const letters = lowered.replaceAll(NOT_LETTERS_AT_EDGES, "");
  return repeatsAnEntry(lowered.trim()) || (letters.length > 0 && repeatsAnEntry(letters));
}

// Messages are generic: they name no list and no source.
export const passwordPolicy = z
  .string()
  // A cheap bound first: an oversized value stops here, so the refinements below never run on it.
  .max(PASSWORD_MAX_LENGTH * 2, { error: LENGTH_MESSAGE, abort: true })
  .refine(
    (value) => codePoints(value) >= PASSWORD_MIN_LENGTH && codePoints(value) <= PASSWORD_MAX_LENGTH,
    LENGTH_MESSAGE,
  )
  .refine((value) => !isCommonPassword(value), "Choose a less common password.");
