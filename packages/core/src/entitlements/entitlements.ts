export type Entitlement =
  | { readonly kind: "unlimited" }
  | { readonly kind: "limited"; readonly limit: number; readonly used: number };

export const ENTITLEMENT_KEYS = ["workspaces", "members"] as const;

export interface Entitlements {
  check(workspaceId: string, key: string): Promise<Entitlement>;
}

export const entitlements: Entitlements = {
  check: async () => ({ kind: "unlimited" }),
};
