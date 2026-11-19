// The plug-in interface of plan limits. Core ships the self-host answer; the cloud supplies its own
// implementation. A plan entitlement is never a feature flag.

export type Entitlement =
  | { readonly kind: "unlimited" }
  | { readonly kind: "limited"; readonly limit: number; readonly used: number };

/** The keys a plan can limit today; the route that reports them and the page that shows them read this list. */
export const ENTITLEMENT_KEYS = ["workspaces", "members"] as const;

export interface Entitlements {
  check(workspaceId: string, key: string): Promise<Entitlement>;
}

/** Self-host: nothing is limited. */
export const entitlements: Entitlements = {
  check: async () => ({ kind: "unlimited" }),
};
