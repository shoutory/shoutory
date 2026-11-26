import { collectSecrets, createScrubber } from "../logging/scrub.js";
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
