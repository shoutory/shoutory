import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import type { ZodType } from "zod";
import { ApiError, request } from "../http/client";

export type Loaded<T> =
  | { readonly status: "loading" }
  | { readonly status: "done"; readonly data: T }
  | { readonly status: "failed"; readonly error: ApiError };

/**
 * Reads one path when the block appears: `replace` swaps the data without a read, `reload` reads again from the
 * loading state, and `refresh` (or a new `stamp`) reads again quietly, keeping what is shown until the answer lands.
 */
export function useLoad<T>(schema: ZodType<T>, path: string, stamp = 0) {
  const [state, setState] = useState<Loaded<T>>({ status: "loading" });
  const [version, setVersion] = useState(0);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  useEffect(() => {
    let current = true;
    void version;
    void stamp;
    request(schema, path).then(
      (data) => current && setState({ status: "done", data }),
      (error: unknown) => {
        if (!(error instanceof ApiError)) throw error;
        if (!current) return;
        // The session ended while the page was open: sign in, then come back to this page.
        if (error.state === "session_expired") {
          void navigate(`/sign-in?return-to=${encodeURIComponent(pathname)}`);
        } else {
          setState({ status: "failed", error });
        }
      },
    );
    return () => {
      current = false;
    };
  }, [schema, path, version, stamp, navigate, pathname]);
  return {
    state,
    replace: (data: T) => setState({ status: "done", data }),
    refresh: () => setVersion((now) => now + 1),
    reload: () => {
      setState({ status: "loading" });
      setVersion((now) => now + 1);
    },
  };
}
