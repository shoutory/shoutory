import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";

// The fragment is replaced out of the address at once, so Back does not restore it and no URL, title or link holds it.
export function useMailedToken(): string | null {
  const { hash, pathname, search } = useLocation();
  const navigate = useNavigate();
  const [token] = useState(() => new URLSearchParams(hash.slice(1)).get("token") || null);
  useEffect(() => {
    if (hash !== "") void navigate(pathname + search, { replace: true });
  }, [hash, pathname, search, navigate]);
  return token;
}
