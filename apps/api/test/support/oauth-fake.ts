import { createHash, randomBytes } from "node:crypto";

// A token pair the OAuth fake issued through its authorization-code flow with PKCE (S256), for the tests that need a
// refresh token the fake will accept.
export const FAKE_CLIENT = "client-1";
const REDIRECT = "http://127.0.0.1:9/callback";

export async function mintTokens(baseUrl: string): Promise<{ access_token: string; refresh_token: string }> {
  const verifier = randomBytes(32).toString("base64url");
  const query = new URLSearchParams({
    response_type: "code",
    client_id: FAKE_CLIENT,
    redirect_uri: REDIRECT,
    state: "state-1",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  });
  const approved = await fetch(`${baseUrl}/authorize?${query}`, { redirect: "manual" });
  const code = new URL(approved.headers.get("location") ?? "").searchParams.get("code") ?? "";
  const answer = await fetch(`${baseUrl}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: FAKE_CLIENT,
      redirect_uri: REDIRECT,
    }),
  });
  return (await answer.json()) as { access_token: string; refresh_token: string };
}
