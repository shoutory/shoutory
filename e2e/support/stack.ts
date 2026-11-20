import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
/** Where a run keeps the founder's saved session; removed with the stack. */
export const STATE_DIR = `${ROOT}.artifacts/e2e`;
const ORIGIN = "http://localhost:3000";
const ROLES = ["owner", "app", "worker", "auth", "readonly"] as const;
const FILES = ["-f", "docker/compose.yml", "-f", "e2e/support/compose.e2e.yml"];
const STACK_TIMEOUT_MS = 600_000;

export interface Stack {
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
    SHOUTORY_PUBLIC_ORIGIN: ORIGIN,
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

/** Builds the image from this checkout and starts the self-host stack with a mail catcher; `down` removes it all. */
export function startStack(): Stack {
  removeStale();
  const project = `${PREFIX}${randomBytes(4).toString("hex")}`;
  const image = `${project}:local`;
  const env = runEnvironment(image);
  const down = () => {
    compose(project, env, ["down", "--volumes", "--remove-orphans"], true);
    spawnSync("docker", ["image", "rm", "--force", image], { stdio: "ignore" });
    rmSync(STATE_DIR, { recursive: true, force: true });
  };
  try {
    compose(project, env, ["up", "--detach", "--build", "--wait", "--wait-timeout", "300"]);
    const port = compose(project, env, ["port", "mail", "8025"]).stdout.trim().split(":").at(-1);
    if (!port) throw new Error("the mail catcher has no published port");
    return { mailUrl: `http://127.0.0.1:${port}`, down };
  } catch (error) {
    down();
    throw error;
  }
}
