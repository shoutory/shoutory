// The workspace opened last, remembered per browser so `/` returns to it. A blocked or full storage is a normal
// answer here: nothing is remembered and `/` opens the first workspace.
const KEY = "shoutory.workspace";

// Storage throws an Error (a DOMException) when it is blocked; anything that is not an Error is not ours to hide.
function storage<T>(use: () => T, fallback: T): T {
  try {
    return use();
  } catch (error) {
    if (error instanceof Error) return fallback;
    throw error;
  }
}

export const lastWorkspace = (): string | null => storage(() => localStorage.getItem(KEY), null);

export const rememberWorkspace = (id: string): void =>
  storage(() => localStorage.setItem(KEY, id), undefined);

/** Sign out clears it: the next person on this browser must not inherit a workspace id. */
export const forgetWorkspace = (): void => storage(() => localStorage.removeItem(KEY), undefined);
