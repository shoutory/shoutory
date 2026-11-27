import type { AdapterContext } from "@shoutory/provider-sdk/adapter";
import { EgressError, isPolicyRefusal } from "@shoutory/provider-sdk/egress/errors";
import { errorResult } from "@shoutory/provider-sdk/result";
import { z } from "zod";
import { call, NO_EFFECT, Refusal, refused, unusable } from "./http.js";

// Built from https://atproto.com/specs/handle (DNS TXT at _atproto.<handle> with `did=<DID>`, or the HTTPS document
// /.well-known/atproto-did; the TXT answer wins; a handle is valid only when the DID document lists it back),
// https://atproto.com/specs/did (a did:web is a hostname alone; the handle is the first `at://` entry of `alsoKnownAs`,
// the PDS the `#atproto_pds` service) and https://w3c-ccg.github.io/did-method-web/ (did:web:<host> is read from
// https://<host>/.well-known/did.json), all read 2026-11-27. A did:plc is read from plc.directory.

export interface Account {
  readonly did: string;
  /** The PDS host (with a port when the document names one). */
  readonly pds: string;
  /** Present only when the DID document and the handle name each other. */
  readonly handle?: string;
}

const HANDLE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// A did:plc is 24 characters of the lowercase base32 alphabet (https://atproto.com/specs/did, read 2026-11-27).
const DID = /^did:(?:plc:[a-z2-7]{24}|web:[a-zA-Z0-9._%-]{1,253})$/;

const didDocument = z.object({
  id: z.string().max(512),
  alsoKnownAs: z.array(z.string().max(512)).max(16).optional().catch(undefined),
  service: z
    .array(z.object({ id: z.string().max(256), type: z.string().max(128), serviceEndpoint: z.unknown() }))
    .max(16)
    .optional()
    .catch(undefined),
});

function documentUrl(did: string): string {
  if (did.startsWith("did:plc:")) return `https://plc.directory/${did}`;
  const host = did.slice("did:web:".length).toLowerCase();
  // A path or a port in a did:web is a development form the product does not take.
  if (host.includes(":") || host.includes("%") || !HANDLE.test(host)) {
    throw new Refusal(refused("did_unsupported"));
  }
  return `https://${host}/.well-known/did.json`;
}

function pdsOf(document: z.infer<typeof didDocument>): string {
  const service = document.service?.find(
    ({ id, type }) => id.endsWith("#atproto_pds") && type === "AtprotoPersonalDataServer",
  );
  const endpoint = typeof service?.serviceEndpoint === "string" ? service.serviceEndpoint : "";
  const url = URL.canParse(endpoint) ? new URL(endpoint) : undefined;
  const bare = url?.protocol === "https:" && url.pathname === "/" && url.search === "" && url.username === "";
  if (url === undefined || !bare) throw new Refusal(refused("pds_unusable"));
  return url.host;
}

async function readDocument(context: AdapterContext, did: string) {
  const reply = await call(context.now, () =>
    context.fetch(documentUrl(did), { headers: { accept: "application/json" } }),
  );
  if (!reply.ok) throw new Refusal(reply.result);
  const parsed = didDocument.safeParse(reply.json);
  if (!parsed.success || parsed.data.id !== did) throw new Refusal(unusable());
  return parsed.data;
}

// The one list of policy classes is the SDK's: an error with the class in its cause is judged the way a fetch error is.
const refusedByPolicy = (egress: string) => isPolicyRefusal(new TypeError("", { cause: { egress } }));

async function viaTxt(context: AdapterContext, handle: string): Promise<string | undefined> {
  if (context.resolveTxt === undefined) return undefined;
  let records: string[];
  try {
    records = await context.resolveTxt(`_atproto.${handle}`);
  } catch (error) {
    if (!(error instanceof EgressError)) throw error;
    // A name with no TXT record is a handle without that method; only the policy classes are a refusal, and a timeout, a
    // failed connection or a long answer is a lookup to try again.
    if (error.class === "dns") return undefined;
    if (refusedByPolicy(error.class)) throw new Refusal(refused("address_not_allowed"));
    throw new Refusal(errorResult({ ...NO_EFFECT, errorClass: "retryable_before_send" }));
  }
  const dids = new Set(records.filter((r) => r.startsWith("did=")).map((r) => r.slice(4).trim()));
  if (dids.size > 1) throw new Refusal(refused("handle_ambiguous"));
  const [did] = dids;
  return did !== undefined && DID.test(did) ? did : undefined;
}

async function viaHttps(context: AdapterContext, handle: string): Promise<string | undefined> {
  const reply = await call(context.now, () => context.fetch(`https://${handle}/.well-known/atproto-did`));
  if (reply.ok) {
    const did = reply.text.trim();
    return DID.test(did) ? did : undefined;
  }
  // A handle that has no document, or whose host does not resolve, is a handle without that method; a refused address or
  // a cut answer is not.
  if ((reply.status !== undefined && reply.status < 500) || reply.egress === "dns") return undefined;
  throw new Refusal(reply.result);
}

export const resolveHandle = async (context: AdapterContext, handle: string) =>
  (await viaTxt(context, handle)) ?? (await viaHttps(context, handle));

const listedHandle = (document: z.infer<typeof didDocument>): string | undefined => {
  const entry = document.alsoKnownAs?.find((name) => name.startsWith("at://"));
  return entry?.slice("at://".length).toLowerCase();
};

// A handle the person typed must resolve to a DID whose document lists it back; a DID's own handle is shown only when
// it passes the same check.
export async function resolveLogin(context: AdapterContext, hint: string): Promise<Account> {
  const typed = hint.trim().replace(/^@/, "").toLowerCase();
  if (typed.startsWith("did:")) {
    if (!DID.test(typed)) throw new Refusal(refused("login_invalid"));
    const document = await readDocument(context, typed);
    const listed = listedHandle(document);
    const claimed = listed !== undefined && HANDLE.test(listed) ? listed : undefined;
    const back = claimed === undefined ? undefined : await resolveHandle(context, claimed);
    return { did: typed, pds: pdsOf(document), ...(back === typed && claimed ? { handle: claimed } : {}) };
  }
  if (!HANDLE.test(typed) || typed.length > 253) throw new Refusal(refused("login_invalid"));
  const did = await resolveHandle(context, typed);
  if (did === undefined) throw new Refusal(refused("handle_unresolved"));
  const document = await readDocument(context, did);
  if (listedHandle(document) !== typed) throw new Refusal(refused("handle_mismatch"));
  return { did, pds: pdsOf(document), handle: typed };
}

const protectedResource = z.object({
  resource: z.string().max(512),
  authorization_servers: z.array(z.string().max(512)).length(1),
});

// RFC 9728 document of the PDS: the one authorization server it trusts, as a bare https origin. The document must be the
// PDS's own: its `resource` is the PDS origin (RFC 9728 section 3.3).
export async function authorizationServerOf(context: AdapterContext, pds: string): Promise<string> {
  const reply = await call(context.now, () =>
    context.fetch(`https://${pds}/.well-known/oauth-protected-resource`, {
      headers: { accept: "application/json" },
    }),
  );
  if (!reply.ok) throw new Refusal(reply.result);
  const parsed = protectedResource.safeParse(reply.json);
  const issuer = parsed.success ? parsed.data.authorization_servers[0] : undefined;
  const url = issuer !== undefined && URL.canParse(issuer) ? new URL(issuer) : undefined;
  const own = parsed.success && parsed.data.resource === `https://${pds}`;
  if (!own || issuer === undefined || url?.protocol !== "https:" || url.origin !== issuer) {
    throw new Refusal(refused("auth_server_unusable"));
  }
  return issuer;
}
