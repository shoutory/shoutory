import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
/** Where a run keeps the founder's saved session; removed with the stack. */
export const STATE_DIR = `${ROOT}.artifacts/e2e`;
/** The one address the app answers on: the compose file publishes this port, and the secure cookies need `localhost`. */
export const APP_ORIGIN = "http://localhost:3000";
const ROLES = ["owner", "app", "worker", "auth", "readonly"] as const;
const FILES = ["-f", "docker/compose.yml", "-f", "e2e/support/compose.e2e.yml"];
const STACK_TIMEOUT_MS = 600_000;

export interface Stack {
  /** The compose project of this run, which names its containers for the log reader. */
  readonly project: string;
  /** Where the mail catcher's API answers on this machine. */
  readonly mailUrl: string;
  down(): void;
}

const secret = () => randomBytes(24).toString("hex");

/** Every secret of one run, made fresh here and handed to compose through its process environment only. */
function runEnvironment(image: string): NodeJS.ProcessEnv {
  const passwords = Object.fromEntries(ROLES.map((role) => [role, secret()]));
  const roleVariables = ROLES.flatMap((role) => {
    const name = role.toUpperCase();
    const url = `postgres://shoutory_${role}:${passwords[role]}@postgres:5432/shoutory`;
    return [
      [`SHOUTORY_DATABASE_PASSWORD_${name}`, passwords[role]],
      [`SHOUTORY_DATABASE_URL_${name}`, url],
    ];
  });
  return {
    ...process.env,
    ...Object.fromEntries(roleVariables),
    SHOUTORY_IMAGE: image,
    SHOUTORY_POSTGRES_PASSWORD: secret(),
    SHOUTORY_PUBLIC_ORIGIN: APP_ORIGIN,
    SHOUTORY_MAIL_FROM: "Shoutory <noreply@e2e.test>",
    SHOUTORY_SMTP_URL: "smtp://mail:1025",
    SHOUTORY_HMAC_PEPPER: secret(),
    SHOUTORY_SESSION_SECRET: secret(),
    SHOUTORY_ACTIVE_KEY_ID: "k1",
    SHOUTORY_KEK_K1: randomBytes(32).toString("base64"),
  };
}

function compose(project: string, env: NodeJS.ProcessEnv, args: string[], allowFailure = false) {
  const result = spawnSync("docker", ["compose", "-p", project, ...FILES, ...args], {
    cwd: ROOT,
    env,
    encoding: "utf8",
    timeout: STACK_TIMEOUT_MS,
  });
  if (result.status !== 0 && !allowFailure) {
    const tail = `${result.stderr}`.trim().split("\n").slice(-8).join(" | ");
    throw new Error(`docker compose ${args[0]} exited ${result.status}: ${tail}`);
  }
  return result;
}

const PREFIX = "shoutory-e2e-";

/** What an interrupted earlier run left behind: its compose projects, built images and saved session. */
function removeStale(): void {
  const listed = spawnSync("docker", ["compose", "ls", "--all", "--format", "json"], { encoding: "utf8" });
  const projects = listed.status === 0 ? (JSON.parse(listed.stdout || "[]") as Array<{ Name: string }>) : [];
  for (const { Name } of projects.filter(({ Name }) => Name.startsWith(PREFIX))) {
    spawnSync("docker", ["compose", "-p", Name, "down", "--volumes", "--remove-orphans"], {
      stdio: "ignore",
    });
  }
  const images = spawnSync("docker", ["images", "--format", "{{.Repository}}:{{.Tag}}"], {
    encoding: "utf8",
  });
  for (const image of images.stdout.split("\n").filter((name) => name.startsWith(PREFIX))) {
    spawnSync("docker", ["image", "rm", "--force", image], { stdio: "ignore" });
  }
  rmSync(STATE_DIR, { recursive: true, force: true });
}

const OWNER = "e2e-owner";
export const REMOVE_BY_VARIABLE = "SHOUTORY_E2E_FLAG_REMOVE_BY";

/** The removal date of the live flags: 90 days ahead, read once per run (global setup) and handed to every spec. */
export const flagRemovalDate = () => new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);

/**
 * The flag rows the stack plants: the migrations seed none, so the flags screen would have nothing to show. The
 * specs call it without an argument and get the run's date from the environment.
 */
export function plantedFlags(removeBy = process.env[REMOVE_BY_VARIABLE]) {
  if (!removeBy) throw new Error("the stack has not published the flags' removal date");
  return {
    live: { key: "e2e_live_flag", owner: OWNER, removeBy, defaultOn: false },
    defaultOn: { key: "e2e_default_on_flag", owner: OWNER, removeBy, defaultOn: true },
    expired: { key: "e2e_expired_flag", owner: OWNER, removeBy: "2000-01-01", defaultOn: false },
  } as const;
}

/** Inserts the planted flags as the database superuser, through the running container (the tables have no app grant). */
function plantFlags(project: string, env: NodeJS.ProcessEnv, removeBy: string): void {
  const rows = Object.values(plantedFlags(removeBy)).map(
    (flag) =>
      `('${flag.key}', 'planted by the e2e stack', '${flag.owner}', date '${flag.removeBy}', ${flag.defaultOn})`,
  );
  const sql = `INSERT INTO app.feature_flags (key, description, owner, remove_by, default_on) VALUES ${rows.join(", ")};`;
  const asSuperuser = ["psql", "-U", "postgres", "-d", "shoutory", "-v", "ON_ERROR_STOP=1"];
  compose(project, env, ["exec", "-T", "postgres", ...asSuperuser, "-c", sql]);
}

/** The DNS sidecar starts first, because the app's `dns:` needs its address, which only exists once it runs. */
function startSidecar(project: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  compose(project, env, ["up", "--detach", "--wait", "dns"]);
  const id = compose(project, env, ["ps", "--quiet", "dns"]).stdout.trim();
  // The address on the stack's own network, named: a container on two networks would otherwise give two addresses.
  const format = `{{(index .NetworkSettings.Networks "${project}_default").IPAddress}}`;
  const inspected = spawnSync("docker", ["inspect", "--format", format, id], { encoding: "utf8" });
  const address = inspected.stdout.trim();
  if (!address) throw new Error("the DNS sidecar has no address on the stack's network");
  return { ...env, SHOUTORY_E2E_DNS_IP: address };
}

/** Builds the image from this checkout and starts the self-host stack with a mail catcher; `down` removes it all. */
export function startStack(removeBy: string): Stack {
  removeStale();
  const project = `${PREFIX}${randomBytes(4).toString("hex")}`;
  const image = `${project}:local`;
  const down = () => {
    compose(project, runEnvironment(image), ["down", "--volumes", "--remove-orphans"], true);
    spawnSync("docker", ["image", "rm", "--force", image], { stdio: "ignore" });
    rmSync(STATE_DIR, { recursive: true, force: true });
  };
  try {
    const env = startSidecar(project, runEnvironment(image));
    compose(project, env, ["up", "--detach", "--build", "--wait", "--wait-timeout", "300"]);
    const port = compose(project, env, ["port", "mail", "8025"]).stdout.trim().split(":").at(-1);
    if (!port) throw new Error("the mail catcher has no published port");
    plantFlags(project, env, removeBy);
    return { project, mailUrl: `http://127.0.0.1:${port}`, down };
  } catch (error) {
    down();
    throw error;
  }
}

const LOG_BUFFER_BYTES = 64 * 1024 * 1024;

/** A docker command's output; a command that fails to run or exits non-zero is an error, never an empty answer. */
function dockerOutput(args: string[]): { stdout: string; stderr: string } {
  const result = spawnSync("docker", args, { encoding: "utf8", maxBuffer: LOG_BUFFER_BYTES });
  if (result.error || result.status !== 0) {
    const reason = result.error?.message ?? `exit ${result.status}: ${result.stderr.trim().slice(-300)}`;
    throw new Error(`docker ${args[0]} failed: ${reason}`);
  }
  return result;
}

/**
 * Every name the app looked up outside the stack since it started, from the sidecar's query log (each name once,
 * lower case, without its trailing dot). Names of the stack's own services never reach the sidecar. Nothing is
 * filtered out here: an unexpected name is for the caller to see.
 */
export function lookedUpNames(): string[] {
  const logs = dockerOutput(["logs", containerOf("dns")]);
  const queries = `${logs.stdout}${logs.stderr}`.matchAll(/"[A-Z0-9]+ IN (\S+) (?:udp|tcp) /g);
  return [...new Set([...queries].map(([, name]) => (name ?? "").replace(/\.$/, "").toLowerCase()))].sort();
}

function containerOf(service: string): string {
  const project = process.env.SHOUTORY_E2E_PROJECT;
  if (!project) throw new Error("the stack has not published its project name");
  const filters = [
    `label=com.docker.compose.project=${project}`,
    `label=com.docker.compose.service=${service}`,
  ];
  const found = dockerOutput(["ps", "--all", "--quiet", ...filters.flatMap((f) => ["--filter", f])]);
  const id = found.stdout.trim();
  if (!id) throw new Error(`the stack has no ${service} container`);
  return id;
}

/**
 * The search domains the app container inherited from its host (the last `search` line of its resolv.conf, lower
 * case). A resolver that is refused a name may retry it under each of them, so the sidecar sees those forms too. No
 * `search` line is a valid answer: there are none. The image has no shell, so its own node reads the file.
 */
export function appSearchDomains(): string[] {
  const read = "process.stdout.write(require('node:fs').readFileSync('/etc/resolv.conf', 'utf8'))";
  const file = dockerOutput(["exec", containerOf("shoutory"), "/nodejs/bin/node", "-e", read]).stdout;
  const line = file.split("\n").findLast((entry) => /^search\s/.test(entry));
  const domains = line ? line.trim().split(/\s+/).slice(1) : [];
  return domains.map((domain) => domain.toLowerCase().replace(/\.$/, ""));
}
