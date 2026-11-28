import { execFileSync } from "node:child_process";
import { createHash, createPublicKey } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { ALL_HOSTS } from "./simulators-plan";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const FOLDER_PREFIX = "shoutory-e2e-sim-";
const FACTS_VARIABLE = "SHOUTORY_E2E_SIMULATORS";
const CURVE = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"];
const VALID_DAYS = "2";

/** What the setup made: the folders compose mounts, and the key hash a browser may be told to accept. */
export interface SimulatorFiles {
  readonly root: string;
  // The two folders are named by the variables the compose file reads.
  readonly env: { SHOUTORY_E2E_CA_DIR: string; SHOUTORY_E2E_SIM_DIR: string };
  readonly caPath: string;
  readonly spki: string;
}

/** What a spec needs, handed on through one environment variable. */
export interface SimulatorFacts {
  readonly port: number;
  readonly caPath: string;
  readonly spki: string;
  readonly telegramToken: string;
  readonly discordWebhook: string;
}

function openssl(args: string[]): string {
  return execFileSync("openssl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// A test CA that lives for two days and signs one certificate that names every host. Its key never leaves the work
// folder, which is deleted before this returns; only the certificate is kept.
function makeCertificates(root: string, caDir: string, simDir: string): void {
  const work = join(root, "work");
  mkdirSync(work);
  const ca = join(caDir, "ca.pem");
  const names = ALL_HOSTS.map((host) => `DNS:${host}`).join(",");
  openssl(
    ["req", "-x509", ...CURVE, "-keyout", join(work, "ca.key"), "-out", ca, "-days", VALID_DAYS]
      .concat(["-subj", "/CN=shoutory e2e test CA", "-addext", "basicConstraints=critical,CA:TRUE"])
      .concat(["-addext", "keyUsage=critical,keyCertSign"]),
  );
  openssl(
    ["req", "-new", ...CURVE, "-keyout", join(simDir, "server.key"), "-out", join(work, "server.csr")].concat(
      ["-subj", "/CN=shoutory e2e simulators"],
    ),
  );
  const extensions = [
    `subjectAltName=${names}`,
    "basicConstraints=critical,CA:FALSE",
    "keyUsage=critical,digitalSignature",
    "extendedKeyUsage=serverAuth",
  ];
  writeFileSync(join(work, "server.ext"), `${extensions.join("\n")}\n`);
  openssl(
    ["x509", "-req", "-in", join(work, "server.csr"), "-CA", ca, "-CAkey", join(work, "ca.key")]
      .concat(["-CAserial", join(work, "ca.srl"), "-CAcreateserial", "-days", VALID_DAYS])
      .concat(["-extfile", join(work, "server.ext"), "-out", join(simDir, "server.pem")]),
  );
  rmSync(work, { recursive: true, force: true });
}

// Chromium takes no extra root from a flag or the environment, but it accepts a certificate whose public key hash it is
// told: the hash of this run's server key, so nothing broader than this one certificate is trusted.
function spkiOf(certificate: string): string {
  const key = createPublicKey(openssl(["x509", "-in", certificate, "-pubkey", "-noout"]));
  return createHash("sha256")
    .update(key.export({ type: "spki", format: "der" }))
    .digest("base64");
}

// The container has Node and nothing of the repository, so the entry is bundled with the workspace sources it imports.
async function bundleSimulators(simDir: string): Promise<void> {
  await build({
    root: ROOT,
    configFile: false,
    logLevel: "warn",
    resolve: { conditions: ["source"] },
    ssr: { noExternal: true, resolve: { conditions: ["source"] } },
    build: {
      ssr: join(ROOT, "e2e/fixtures/simulators-server.ts"),
      outDir: simDir,
      emptyOutDir: false,
      minify: false,
      rollupOptions: { output: { entryFileNames: "simulators.mjs", format: "es" } },
    },
  });
}

export async function prepareSimulators(): Promise<SimulatorFiles> {
  const root = mkdtempSync(join(tmpdir(), FOLDER_PREFIX));
  try {
    const [caDir, simDir] = [join(root, "ca"), join(root, "sim")];
    for (const folder of [caDir, simDir]) mkdirSync(folder);
    // The CA folder is read by the app's user and the simulators folder by root, whoever started the run.
    chmodSync(caDir, 0o755);
    makeCertificates(root, caDir, simDir);
    chmodSync(join(caDir, "ca.pem"), 0o644);
    await bundleSimulators(simDir);
    return {
      root,
      env: { SHOUTORY_E2E_CA_DIR: caDir, SHOUTORY_E2E_SIM_DIR: simDir },
      caPath: join(caDir, "ca.pem"),
      spki: spkiOf(join(simDir, "server.pem")),
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

/** Removes the folder this run made and nothing else: another run on the same machine keeps its own. */
export function removeSimulatorFiles(files: SimulatorFiles): void {
  rmSync(files.root, { recursive: true, force: true });
}

/** Called once the container is up: it wrote what it issued into its folder. */
export function publishSimulators(files: SimulatorFiles, port: number): void {
  const ready = JSON.parse(readFileSync(join(files.env.SHOUTORY_E2E_SIM_DIR, "ready.json"), "utf8")) as Pick<
    SimulatorFacts,
    "telegramToken" | "discordWebhook"
  >;
  const facts: SimulatorFacts = { ...ready, port, caPath: files.caPath, spki: files.spki };
  process.env[FACTS_VARIABLE] = JSON.stringify(facts);
}

export function simulators(): SimulatorFacts {
  const text = process.env[FACTS_VARIABLE];
  if (!text) throw new Error("the stack has not published its simulators");
  return JSON.parse(text) as SimulatorFacts;
}

/**
 * The Chromium arguments that send every simulator host to the published port and accept this run's certificate.
 * `extraRules` are more resolver rules for the same browser (a flag given twice keeps only its last value).
 */
export function simulatorBrowserArgs(extraRules: readonly string[] = [], facts = simulators()): string[] {
  const mapped = ALL_HOSTS.map((host) => `MAP ${host} 127.0.0.1:${facts.port}`);
  // A proxy from the machine's settings or environment is chosen by the name in the address, before the rules turn it
  // into a local port, so it would be asked to fetch the simulators' names from the internet.
  return [
    "--proxy-server=direct://",
    `--host-resolver-rules=${[...mapped, ...extraRules].join(", ")}`,
    `--ignore-certificate-errors-spki-list=${facts.spki}`,
  ];
}
