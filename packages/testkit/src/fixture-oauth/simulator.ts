import type { StoredPost } from "@shoutory/provider-sdk/conformance/fault-matrix";
import { fixtureRoutes } from "../fixture-provider/simulator.js";
import { type OAuthFakeOptions, oauthRoutes } from "../oauth-fake/server.js";
import { startSimulator } from "../simulator/server.js";

/**
 * Starts the `fixture-oauth` network: the authorization server of the oauth fake and the fixture post routes on one
 * loopback port. The post routes do not check the token. The result is the simulator plus the oauth fake's arming call.
 */
export async function startFixtureOAuthSimulator(options: OAuthFakeOptions) {
  const posts = new Map<string, StoredPost>();
  const oauth = oauthRoutes(options);
  const simulator = await startSimulator({ ...fixtureRoutes(posts), ...oauth.routes });
  return Object.assign(simulator, { omitNextRefreshToken: oauth.omitNextRefreshToken });
}
