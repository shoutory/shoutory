import { type Planted, U } from "./members-seed.js";

// The accept table of R242: who asks, in what state the row is, and the one answer each case gets. `mutate` runs as
// the superuser before the call and changes the inviter's standing.
export interface AcceptCase {
  title: string;
  planted: Planted | null;
  caller: string;
  mutate?: string;
  state: string;
  message: RegExp;
}

const TAKE = "-m06a@example.test";
const ROLE_OF = (key: string) => `(SELECT id FROM app.roles WHERE workspace_id IS NULL AND key = '${key}')`;
const NOT_INVITABLE = /^invitation_accept:/;
const MISMATCH = /^invitation_accept: email_mismatch/;
const REVOKED = /^invitation_accept: revoked/;
const EXPIRED = { token: "", expires: "-1 hour" };

export const ACCEPT_CASES: AcceptCase[] = [
  { title: "a forged token", planted: null, caller: U.invitee, state: "42501", message: NOT_INVITABLE },
  {
    title: "a planted owner-role row",
    planted: { token: "", role: "owner" },
    caller: U.invitee,
    state: "42501",
    message: NOT_INVITABLE,
  },
  {
    title: "a planted non-built-in role row",
    planted: { token: "", role: "custom-m06a" },
    caller: U.invitee,
    state: "42501",
    message: NOT_INVITABLE,
  },
  {
    title: "another account on a live row",
    planted: { token: "" },
    caller: U.outsider,
    state: "SH403",
    message: MISMATCH,
  },
  {
    title: "another account on a used row",
    planted: { token: "", used: true },
    caller: U.outsider,
    state: "SH403",
    message: MISMATCH,
  },
  {
    title: "another account on a revoked row",
    planted: { token: "", revoked: true },
    caller: U.outsider,
    state: "SH403",
    message: MISMATCH,
  },
  {
    title: "another account on an expired row",
    planted: EXPIRED,
    caller: U.outsider,
    state: "SH403",
    message: MISMATCH,
  },
  {
    title: "an unverified account",
    planted: { token: "", email: `unverified${TAKE}` },
    caller: U.unverified,
    state: "SH403",
    message: /^invitation_accept: email_unverified/,
  },
  {
    title: "the invited account on a used row",
    planted: { token: "", used: true },
    caller: U.invitee,
    state: "SH410",
    message: /^invitation_accept: used/,
  },
  {
    title: "the invited account on a revoked row",
    planted: { token: "", revoked: true },
    caller: U.invitee,
    state: "SH410",
    message: REVOKED,
  },
  {
    title: "the invited account on an expired row",
    planted: EXPIRED,
    caller: U.invitee,
    state: "SH410",
    message: /^invitation_accept: expired/,
  },
  {
    title: "an inviter demoted below the row's role",
    planted: { token: "", by: U.inviter1 },
    caller: U.invitee,
    mutate: `UPDATE app.workspace_members SET role_id = ${ROLE_OF("viewer")} WHERE user_id = '${U.inviter1}'`,
    state: "SH410",
    message: REVOKED,
  },
  {
    title: "an inviter removed from the workspace",
    planted: { token: "", by: U.inviter2 },
    caller: U.invitee,
    mutate: `DELETE FROM app.workspace_members WHERE user_id = '${U.inviter2}'`,
    state: "SH410",
    message: REVOKED,
  },
  {
    title: "an implicit-admin inviter who lost the organization role",
    planted: { token: "", by: U.inviter3 },
    caller: U.invitee,
    mutate: `DELETE FROM app.organization_members WHERE user_id = '${U.inviter3}'`,
    state: "SH410",
    message: REVOKED,
  },
  {
    title: "an account that is already a member",
    planted: { token: "", email: `alreadymember${TAKE}` },
    caller: U.alreadyMember,
    state: "SH409",
    message: /^invitation_accept: already_member/,
  },
];
