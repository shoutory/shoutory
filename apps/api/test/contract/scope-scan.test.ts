import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// This is a text tripwire, not a proof: it catches a cast or an import in the wrong place, while forging the type
// stays impossible because the brand symbol is never exported. An AuthorizedScope exists only if the permission module minted it from the resolved rows (R211): the brand is built
// in packages/core/src/authz, mintScope is imported only by the db context, and a route reaches data only through the
// scope the route table minted, never through withTenant.

const ROOT = resolve(import.meta.dirname, "../../../..");
const SKIPPED = new Set(["node_modules", "dist", ".turbo", ".artifacts"]);

async function sources(root: string, folder: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && !SKIPPED.has(entry.name)) await walk(path);
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) found.push(path);
    }
  };
  await walk(join(root, folder));
  return found;
}

const norm = (root: string, file: string) => relative(root, file).replaceAll("\\", "/");

interface Facts {
  readonly brandOutsideCore: string[];
  readonly mintOutsideContext: string[];
  readonly routesUsingWithTenant: string[];
  readonly inputs: { readonly brand: number; readonly mintImporters: number; readonly routeFiles: number };
}

// The patterns are built from parts so that this file never contains the text it looks for.
const BRAND = new RegExp(`as\\s+Authorized${"Scope"}\\b|unique\\s+symbol[^;]*${"Authorized"}`);
const MINT = new RegExp(`\\b${"mint"}Scope\\b`);
const TENANT = new RegExp(`\\bwith${"Tenant"}\\b`);

async function scan(root: string): Promise<Facts> {
  const all = await Promise.all(["apps", "packages"].map((top) => sources(root, top))).then((lists) =>
    lists.flat(),
  );
  const read = async (files: string[]) =>
    Promise.all(files.map(async (file) => ({ path: norm(root, file), text: await readFile(file, "utf8") })));
  const files = await read(all);
  const inCore = (path: string) => path.startsWith("packages/core/src/authz/");
  const inContext = (path: string) => path.startsWith("packages/db/src/context/");
  const routes = files.filter((file) => file.path.startsWith("apps/api/src/routes/"));
  return {
    brandOutsideCore: files.filter((f) => BRAND.test(f.text) && !inCore(f.path)).map((f) => f.path),
    mintOutsideContext: files
      .filter((f) => MINT.test(f.text) && !inCore(f.path) && !inContext(f.path))
      .map((f) => f.path),
    routesUsingWithTenant: routes.filter((f) => TENANT.test(f.text)).map((f) => f.path),
    inputs: {
      brand: files.filter((f) => inCore(f.path) && /unique\s+symbol/.test(f.text) && MINT.test(f.text))
        .length,
      mintImporters: files.filter((f) => inContext(f.path) && MINT.test(f.text)).length,
      routeFiles: routes.filter((f) => f.path.startsWith("apps/api/src/routes/workspaces/")).length,
    },
  };
}

describe("the scope scan finds a planted violation (fixtures are built at run time)", () => {
  const plant = async (file: string, text: string): Promise<Facts> => {
    const root = await mkdtemp(join(tmpdir(), "scope-scan-"));
    try {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await writeFile(join(root, file), text);
      return await scan(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  };

  it.each([
    ["brandOutsideCore", "packages/db/src/forged.ts", `const s = {} as Authorized${"Scope"};`],
    [
      "mintOutsideContext",
      "apps/api/src/routes/forged.ts",
      `import { mint${"Scope"} } from "@shoutory/core";`,
    ],
    [
      "routesUsingWithTenant",
      "apps/api/src/routes/forged.ts",
      `import { with${"Tenant"} } from "@shoutory/db/context";`,
    ],
  ] as const)("%s is reported", async (key, file, text) => {
    expect((await plant(file, text))[key]).toEqual([file]);
  });
});

describe("the scope of the real tree", () => {
  it("is built in core authz, minted only from the db context, and never bypassed by a route", async () => {
    const facts = await scan(ROOT);
    expect(facts.brandOutsideCore).toEqual([]);
    expect(facts.mintOutsideContext).toEqual([]);
    expect(facts.routesUsingWithTenant).toEqual([]);
    // Minimum inputs: a scan over nothing proves nothing.
    expect(facts.inputs.brand, "the brand and mintScope live in packages/core/src/authz").toBeGreaterThan(0);
    expect(facts.inputs.mintImporters, "packages/db/src/context calls mintScope").toBeGreaterThan(0);
    expect(
      facts.inputs.routeFiles,
      "apps/api/src/routes/workspaces holds the workspace routes",
    ).toBeGreaterThan(0);
  });
});
