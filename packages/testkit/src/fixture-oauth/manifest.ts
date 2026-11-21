import { fixtureManifest } from "../fixture-provider/manifest.js";

/**
 * The manifest of `fixture-oauth`: the `fixture` network behind an OAuth 2.1 authorization server with PKCE. Its id is
 * `fixture_oauth` because a manifest id allows no hyphen. It is registered only in tests.
 */
export const fixtureOAuthManifest = {
  ...fixtureManifest,
  id: "fixture_oauth",
  displayName: "Fixture OAuth Network",
  auth: { method: "oauth2_pkce" },
  scopes: ["post.write", "offline_access"],
  capabilities: [...fixtureManifest.capabilities, "refresh"],
  refreshErrorMap: {
    invalid_grant: "revoked",
    temporarily_unavailable: "transient",
    slow_down: "rate_limited",
    invalid_client: "config",
  },
} as const;
