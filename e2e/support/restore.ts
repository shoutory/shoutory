import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { test } from "@playwright/test";
import { FOUNDER_STATE } from "./journey";
import { APP_ORIGIN, composeInStack, STATE_DIR } from "./stack";

// The commands of the backup guide, word for word; a contract test keeps the guide and this file the same.
const COMMANDS = JSON.parse(
  readFileSync(new URL("./restore-commands.json", import.meta.url), "utf8"),
) as Record<"dump" | "copyOut" | "copyIn" | "restore" | "secretsCheck", string>;
const DUMP_FILE = `${STATE_DIR}/shoutory.dump`;
const POLL_MS = 500;
const WAIT_MS = 60_000;
const STEP_MS = 30_000;

interface Ran {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

// The guide's own `./shoutory.dump` is the run's state folder here.
function guide(command: string, allowFailure = false): Ran {
  const args = command
    .replace(/^docker compose /, "")
    .split(" ")
    .map((word) => (word === "./shoutory.dump" ? DUMP_FILE : word));
  const result = composeInStack(args, allowFailure);
  return { status: result.status ?? 1, stdout: `${result.stdout}`, stderr: `${result.stderr}` };
}

const project = () => process.env.SHOUTORY_E2E_PROJECT ?? "";
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

function psql(sql: string): string {
  const args = ["exec", "-T", "postgres", "psql", "-U", "postgres", "-d", "shoutory", "-qAt", "-c", sql];
  return composeInStack(args).stdout.trim();
}

// What a restore must give back, read in one superuser call while the app is down: the first row is counted as the
// superuser, the second as the app role (SET ROLE keeps no tenant context, so row security shows it nothing).
const FACTS_SQL = `
SELECT (SELECT count(*) FROM app.workspaces),
  (SELECT count(*) FROM app.workspace_members),
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname IN ('app', 'auth') AND c.relkind IN ('r', 'p') AND c.relforcerowsecurity),
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname IN ('app', 'auth') AND c.relkind IN ('r', 'p') AND c.relrowsecurity
       AND NOT c.relforcerowsecurity),
  (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'shoutory_app');
SET ROLE shoutory_app;
SELECT count(*) FROM app.workspaces;`;

export interface DatabaseFacts {
  readonly workspaces: number;
  readonly members: number;
  readonly forced: number;
  readonly enabledNotForced: number;
  readonly bypassRls: boolean;
  readonly visibleRows: number;
}

export function databaseFacts(): DatabaseFacts {
  const [row = "", visible = ""] = psql(FACTS_SQL).split("\n");
  const [workspaces, members, forced, enabledNotForced, bypass] = row.split("|");
  return {
    workspaces: Number(workspaces),
    members: Number(members),
    forced: Number(forced),
    enabledNotForced: Number(enabledNotForced),
    bypassRls: bypass === "t",
    visibleRows: Number(visible),
  };
}

// A mail link sealed in the outbox and never sent is the only row `secrets check` can read.
export async function plantUnsentLink(email: string): Promise<void> {
  composeInStack(["stop", "mail"]);
  const answer = await fetch(`${APP_ORIGIN}/api/auth/request-password-reset`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: APP_ORIGIN, "X-Shoutory-Client": "web" },
    body: JSON.stringify({ email }),
  });
  if (!answer.ok) throw new Error(`the password reset request answered ${answer.status}`);
  const deadline = Date.now() + WAIT_MS;
  while (Number(psql("SELECT count(*) FROM app.email_outbox WHERE link_ciphertext IS NOT NULL")) < 1) {
    if (Date.now() > deadline) throw new Error("no sealed mail link reached the outbox");
    await sleep(POLL_MS);
  }
}

export function dumpAndLoseTheVolume(): void {
  guide(COMMANDS.dump);
  guide(COMMANDS.copyOut);
  composeInStack(["stop", "shoutory"]);
  composeInStack(["rm", "--stop", "--force", "postgres"]);
  const removed = spawnSync("docker", ["volume", "rm", `${project()}_postgres-data`], { encoding: "utf8" });
  if (removed.status !== 0) throw new Error(`the database volume was not removed: ${removed.stderr.trim()}`);
}

export function restoreTheDump(): void {
  composeInStack(["up", "--detach", "--wait", "--wait-timeout", "300", "postgres"]);
  guide(COMMANDS.copyIn);
  guide(COMMANDS.restore);
}

// A key ring without the saved id starts the same image with another active key and no `k1`, which compose cannot do
// to its own service, so the image runs by hand and depends on the worker's URL variable and the app's key variable names.
export function secretsCheck(ring: "saved" | "without-the-saved-id"): Ran {
  if (ring === "saved") return guide(COMMANDS.secretsCheck, true);
  const network = ["--network", `${project()}_default`];
  const keys = [
    "-e",
    "SHOUTORY_DATABASE_URL_WORKER",
    "-e",
    "SHOUTORY_ACTIVE_KEY_ID=k2",
    "-e",
    "SHOUTORY_KEK_K2",
  ];
  const run = spawnSync(
    "docker",
    ["run", "--rm", ...network, ...keys, process.env.SHOUTORY_IMAGE ?? "", "secrets", "check"],
    { encoding: "utf8", env: { ...process.env, SHOUTORY_KEK_K2: randomBytes(32).toString("base64") } },
  );
  return { status: run.status ?? 1, stdout: run.stdout, stderr: run.stderr };
}

// The server accepts each code once (the `used` map in totp.ts only knows the codes of its own process), and the first
// journey's second code is the next step's, so the last step the server saw can be one ahead of that journey's clock.
// A code is fresh once two whole steps have passed since the journey saved its session (or, for a member of its own,
// since the member's last code, the file `savedFile` names). The wait is a protocol fact, so it extends the running
// test's timeout by the time it sleeps.
export async function waitForFreshCode(savedFile: string = FOUNDER_STATE): Promise<void> {
  const savedAt = statSync(savedFile).mtimeMs;
  const fresh = (Math.floor(savedAt / STEP_MS) + 2) * STEP_MS;
  const waitMs = fresh - Date.now();
  if (waitMs <= 0) return;
  test.info().setTimeout(test.info().timeout + waitMs);
  await sleep(waitMs);
}

export function startApp(): void {
  composeInStack(["up", "--detach", "--wait", "--wait-timeout", "300"]);
}
