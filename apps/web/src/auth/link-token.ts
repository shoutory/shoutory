import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";

/**
 * The token of a mailed link: it rides in the fragment (`#token=…`), is read once into memory, and the fragment is
 * replaced out of the address at once, so Back does not restore it and no URL, title or link ever holds it. A page
 * opened with no token gets `null`.
 */
export function useMailedToken(): string | null {
  const { hash, pathname, search } = useLocation();
  const navigate = useNavigate();
  // An empty `#token=` is no token.
  const [token] = useState(() => new URLSearchParams(hash.slice(1)).get("token") || null);
  useEffect(() => {
    if (hash !== "") void navigate(pathname + search, { replace: true });
  }, [hash, pathname, search, navigate]);
  return token;
}
