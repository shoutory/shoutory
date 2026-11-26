import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import type { ZodType } from "zod";
import { ApiError, request } from "../http/client";

export type Loaded<T> =
  | { readonly status: "loading" }
  | { readonly status: "done"; readonly data: T }
  | { readonly status: "failed"; readonly error: ApiError };

export function useLoad<T>(
  schema: ZodType<T>,
  path: string,
  stamp = 0,
  read: (schema: ZodType<T>, path: string) => Promise<T> = request,
) {
  const [state, setState] = useState<Loaded<T>>({ status: "loading" });
  const [version, setVersion] = useState(0);
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  useEffect(() => {
    let current = true;
    void version;
    void stamp;
    read(schema, path).then(
      (data) => current && setState({ status: "done", data }),
      (error: unknown) => {
        if (!(error instanceof ApiError)) throw error;
        if (!current) return;
        if (error.state === "session_expired") {
          void navigate(`/sign-in?return-to=${encodeURIComponent(pathname + search)}`);
        } else {
          setState({ status: "failed", error });
        }
      },
    );
    return () => {
      current = false;
    };
  }, [schema, path, version, stamp, read, navigate, pathname, search]);
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
