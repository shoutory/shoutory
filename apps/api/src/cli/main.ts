import { SECRET_VARIABLES } from "@shoutory/core/config";
import { createScrubber } from "../logging/scrub.js";
import { auditVerifyCommand } from "./audit-verify.js";
import { mailCheckCommand } from "./mail-check.js";
import { migrateCommand } from "./migrate.js";
import { checkCommand } from "./secrets/check.js";
import { resealCommand } from "./secrets/reseal.js";
import { storageCheckCommand } from "./storage-check.js";

export interface CliIo {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

const USAGE =
  "usage: shoutory <command>; commands: migrate, mail check, storage check, secrets check, secrets reseal, audit verify [YYYY-MM-DD]";
const KEK_PREFIX = "SHOUTORY_KEK_";
const MIN_SECRET_LENGTH = 8;

function decodedPassword(value: string): string | undefined {
  if (!URL.canParse(value)) return undefined;
  try {
    return decodeURIComponent(new URL(value).password);
  } catch (error) {
    if (error instanceof URIError) return undefined;
    throw error;
  }
}

/** The values the logger must never print: every set secret variable, every KEK and the password inside a URL. */
export function collectSecrets(env: NodeJS.ProcessEnv): string[] {
  const names = [...SECRET_VARIABLES, ...Object.keys(env).filter((name) => name.startsWith(KEK_PREFIX))];
  const values = names.flatMap((name) => {
    const value = env[name];
    return value ? [value, decodedPassword(value)] : [];
  });
  const usable = values.filter((v): v is string => v !== undefined && v.length >= MIN_SECRET_LENGTH);
  return [...new Set(usable)];
}

type Command = (env: NodeJS.ProcessEnv, io: CliIo) => Promise<number>;

// A command is the whole argument list, so an extra or a missing word is a usage error.
const COMMANDS: ReadonlyMap<string, Command> = new Map([
  [
    "migrate",
    async (env, io) => {
      await migrateCommand(env, io.stdout);
      return 0;
    },
  ],
  ["mail check", (env, io) => mailCheckCommand(env, io)],
  ["storage check", storageCheckCommand],
  ["secrets check", checkCommand],
  ["secrets reseal", resealCommand],
]);

/** Runs one command and returns its exit code; starting a process around it is the server slice's job. */
export async function run(argv: readonly string[], env: NodeJS.ProcessEnv, io: CliIo): Promise<number> {
  // `audit verify` is the one command with an argument of its own (a day); it checks that argument itself.
  const withDay = argv[0] === "audit" && argv[1] === "verify";
  const command = withDay
    ? (e: NodeJS.ProcessEnv, i: CliIo) => auditVerifyCommand(e, i, argv.slice(2))
    : COMMANDS.get(argv.join(" "));
  if (!command) {
    io.stderr(USAGE);
    return 2;
  }
  try {
    return await command(env, io);
  } catch (error) {
    const message = error instanceof Error ? error.message : "the command failed";
    io.stderr(String(createScrubber(collectSecrets(env))(message)));
    return 1;
  }
}
