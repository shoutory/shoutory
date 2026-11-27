import type { ProviderAdapter } from "@shoutory/provider-sdk/adapter";
import { errorResult, type ProviderResult } from "@shoutory/provider-sdk/result";

const refused = async (): Promise<ProviderResult> =>
  errorResult({ effect: "none", errorClass: "permanent", providerCode: "not_implemented" });

export const createDiscordAdapter = (): ProviderAdapter => ({
  prepare: refused,
  commit: refused,
  readBack: refused,
  edit: refused,
  delete: refused,
  inspect: refused,
});
