import { AsyncLocalStorage } from "node:async_hooks";

// The mount asks the database whether an address may sign up and, on a yes, runs the library's sign-up inside this
// marker. The library's user-creation hook then only reads the marker: it makes no database call, so it never takes
// a second pool connection while the library's transaction holds one. A creator path that skips the mount gate has no
// marker and is refused, open instance or not.
const allowed = new AsyncLocalStorage<string>();

export const allowSignup = <T>(email: string, run: () => Promise<T>): Promise<T> =>
  allowed.run(email.toLowerCase(), run);

export const signupAllowed = (email: string): boolean => allowed.getStore() === email.toLowerCase();
