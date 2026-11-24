import { fixtureManifest } from "../fixture-provider/manifest.js";

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
