import { strict as assert } from "node:assert";
import { existsSync, globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../..");
const EGRESS_DIR = "packages/provider-sdk/src/egress/";
const SKIPPED = new Set(["node_modules", "dist", ".git", ".artifacts", ".turbo"]);
const GLOBS = ["{apps/*,packages/*,packages/providers/*}/src/**/*.{ts,tsx,mts,js,cjs,mjs}"];
const EXTENSIONS = ["ts", "tsx", "mts", "js", "cjs", "mjs"];
const EXCEPTIONS = JSON.parse(readFileSync(join(here, "egress-operator-exceptions.json"), "utf8"));

// The banned words are joined here so this file never matches its own scan.
const word = (...parts) => parts.join("");
const FETCH = word("fe", "tch");
const MODULE = (name) => `["'](?:node:)?${name}["']`;

// The node network modules are an allowlist: a value import of one is a finding unless every named binding is in this
// closed list (none of them opens a connection). A default or namespace import, a side-effect import, a re-export,
// a dynamic `import()` and a `require()` are always findings.
const NET_MODULES = "(?:node:)?(?:https?|http2|net|tls|dgram|dns(?:/promises)?)";
const ALLOWED_BINDINGS = new Set(["createServer", "isIP", "isIPv4", "isIPv6", "BlockList", "SocketAddress"]);
const DYNAMIC_NET = new RegExp(`\\b(?:import|require)\\s*\\(\\s*["']${NET_MODULES}["']\\s*\\)`);
const SIDE_EFFECT_NET = new RegExp(`\\bimport\\s*["']${NET_MODULES}["']`);
const STATIC_NET = new RegExp(
  `\\b(?:import|export)\\b((?:(?!\\b(?:import|export)\\b)[^;"'\`])*?)\\bfrom\\s*["']${NET_MODULES}["']`,
  "g",
);

function onlyAllowedBindings(clause) {
  const named = /^\s*\{([^}]*)\}\s*$/.exec(clause);
  if (!named) return false;
  return named[1]
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "" && !/^type\s/.test(part))
    .every((part) => ALLOWED_BINDINGS.has(part.split(/\s+as\s+/)[0].trim()));
}

function reachesNetworkModule(code) {
  if (DYNAMIC_NET.test(code) || SIDE_EFFECT_NET.test(code)) return true;
  return [...code.matchAll(STATIC_NET)].some((match) => !onlyAllowedBindings(match[1]));
}

// The global fetch by any route. A bare `fetch` is a finding unless it is a property key (after `{`, `,` or `;`, or
// after `readonly`, and followed by a colon), a member `x.fetch`, or `typeof fetch` in a type position. Tested on the
// code with literals blanked, so "sec-fetch-site" and "fetch failed" do not count and `globalThis["fetch"]` shows up
// as `globalThis[""]`.
const NAMED = `(?<![\\w$.-])(?<!typeof\\s+)`;
const BARE_FETCH = new RegExp(
  `${NAMED}(?<![{,;]\\s*|\\breadonly\\s+)${FETCH}(?![\\w$-])|${NAMED}${FETCH}(?![\\w$-])(?!\\s*\\??:(?!:))`,
);
const GLOBAL_FETCH = new RegExp(
  [
    `(?<![\\w$.])(?:globalThis|global|self|window)\\.${FETCH}\\b`,
    "\\bglobalThis\\s*\\[",
    `\\{[^{}]*\\b${FETCH}\\b[^{}]*\\}\\s*=(?!=)`,
  ].join("|"),
);

// One entry per way of opening a connection: [name, (code, bare) => found]. `import type` is removed before the
// tests run. In `code` string literals are kept (module names are strings); in `bare` they are blanked.
const RULES = [
  ["the global fetch", (_code, bare) => BARE_FETCH.test(bare) || GLOBAL_FETCH.test(bare)],
  ["a node network module", (code) => reachesNetworkModule(code)],
  ["a dns Resolver", (code) => /new\s+(?:dns\.)?Resolver\b/.test(code)],
  [
    "an undici import",
    (code) => new RegExp(`(?:from\\s*|import\\(\\s*|require\\(\\s*)${MODULE("undici")}`).test(code),
  ],
  ["a websocket", (code) => new RegExp(`new\\s+WebSocket\\b|from\\s*${MODULE("ws")}`).test(code)],
  ["the S3 driver", (code) => /(?:from\s*|import\(\s*)["']@aws-sdk\/client-s3["']/.test(code)],
  ["the SMTP driver", (code) => new RegExp(`(?:from\\s*|import\\(\\s*)${MODULE("nodemailer")}`).test(code)],
  // Also as a dynamic import: the telemetry module loads the exporter only when an endpoint is set.
  ["an OTLP exporter", (code) => /(?:from\s*|import\(\s*)["']@opentelemetry\/exporter-[\w-]+["']/.test(code)],
];

function inTestFile(file) {
  return file.split("/").includes("test") || /\.test\.(ts|tsx|mts|js|cjs|mjs)$/.test(file);
}

function scannedFiles(base) {
  const exclude = (name) => SKIPPED.has(name);
  return GLOBS.flatMap((pattern) => globSync(pattern, { cwd: base, exclude }))
    .map((file) => file.replaceAll("\\", "/"))
    .filter(
      (file) =>
        !file.startsWith(EGRESS_DIR) &&
        !file.startsWith("packages/testkit/") &&
        !file.startsWith("apps/web/") &&
        !inTestFile(file),
    );
}

// A `/` starts a regular expression after one of these, and starts a division after a name, a number or a closer.
const BEFORE_REGEX =
  /(?:^|[(,=:[!&|?{};+\-*%<>~^]|\b(?:return|typeof|case|void|delete|in|of|else|do|throw|new|yield|await))\s*$/;

// Reads the source once, left to right, so a comment marker inside a string, a template or a regular expression cannot
// hide code. `code` keeps literals; `bare` blanks them too.
class Scanner {
  code = "";
  bare = "";
  at = 0;
  constructor(text) {
    this.text = text;
  }

  keep(raw, blank = raw) {
    this.code += raw;
    this.bare += blank;
    this.at += raw.length;
  }

  drop(length) {
    this.at += length;
  }

  lineComment() {
    const end = this.text.indexOf("\n", this.at);
    this.drop((end === -1 ? this.text.length : end) - this.at);
  }

  blockComment() {
    const end = this.text.indexOf("*/", this.at + 2);
    this.drop((end === -1 ? this.text.length : end + 2) - this.at);
    this.code += " ";
    this.bare += " ";
  }

  quoted(quote) {
    let end = this.at + 1;
    while (end < this.text.length && this.text[end] !== quote && this.text[end] !== "\n") {
      end += this.text[end] === "\\" ? 2 : 1;
    }
    const raw = this.text.slice(this.at, end + 1);
    this.code += raw;
    this.bare += `${quote}${quote}`;
    this.at += raw.length;
  }

  regex() {
    let end = this.at + 1;
    for (let inClass = false; end < this.text.length && this.text[end] !== "\n"; end += 1) {
      const c = this.text[end];
      if (c === "\\") end += 1;
      else if (c === "[" || c === "]") inClass = c === "[";
      else if (c === "/" && !inClass) break;
    }
    const raw = this.text.slice(this.at, end + 1);
    this.code += raw;
    this.bare += "/ /";
    this.at += raw.length;
  }

  template() {
    this.keep("`");
    while (this.at < this.text.length && this.text[this.at] !== "`") this.templatePart();
    this.keep("`");
  }

  templatePart() {
    if (this.text.startsWith("${", this.at)) {
      this.keep("${");
      this.run(true);
      this.keep("}");
      return;
    }
    const length = this.text[this.at] === "\\" ? 2 : 1;
    this.code += this.text.slice(this.at, this.at + length);
    this.at += length;
  }

  step(depth, inExpression) {
    const c = this.text[this.at];
    const pair = this.text.slice(this.at, this.at + 2);
    if (pair === "//") this.lineComment();
    else if (pair === "/*") this.blockComment();
    else if (c === '"' || c === "'") this.quoted(c);
    else if (c === "`") this.template();
    else if (c === "/" && BEFORE_REGEX.test(this.bare.slice(-24))) this.regex();
    else if (c === "}" && inExpression && depth.value === 0) return true;
    else {
      depth.value += c === "{" ? 1 : c === "}" ? -1 : 0;
      this.keep(c);
    }
    return false;
  }

  run(inExpression) {
    const depth = { value: 0 };
    while (this.at < this.text.length && !this.step(depth, inExpression));
  }
}

function scan(text) {
  const scanner = new Scanner(text);
  scanner.run(false);
  return { code: scanner.code, bare: scanner.bare };
}

function codeOf(text) {
  const { code, bare } = scan(text);
  const types = /\b(?:import|export)\s+type\s[^;]*?from\s*["'][^"']+["']/g;
  return { code: code.replace(types, ""), bare };
}

function uses(text) {
  const { code, bare } = codeOf(text);
  return RULES.filter(([, found]) => found(code, bare)).map(([name]) => name);
}

const filesWithUse = (base) =>
  scannedFiles(base).filter((file) => uses(readFileSync(join(base, file), "utf8")).length > 0);
const unlisted = (base, rows) => filesWithUse(base).filter((file) => !rows.some((row) => row.path === file));
function rowProblems(base, rows) {
  const withUse = new Set(filesWithUse(base));
  return rows.flatMap((row) => {
    if (typeof row.id !== "string" || row.id === "") return [`${row.path}: no id`];
    if (typeof row.reason !== "string" || row.reason.trim() === "") return [`${row.path}: no reason`];
    if (!existsSync(join(base, row.path))) return [`${row.path}: the file does not exist`];
    return withUse.has(row.path) ? [] : [`${row.path}: no network use`];
  });
}

function plant(files) {
  const base = mkdtempSync(join(tmpdir(), "egress-only-"));
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(base, file)), { recursive: true });
    writeFileSync(join(base, file), content);
  }
  return base;
}

test("no network call outside the egress directory or an exception row", () => {
  assert.ok(scannedFiles(root).length >= 10, "fewer than 10 files were scanned");
  assert.deepEqual(unlisted(root, EXCEPTIONS), []);
});

test("the exceptions list is closed: every row names a file that exists, holds a network use and has a reason", () => {
  assert.ok(EXCEPTIONS.length > 0, "the list is empty");
  assert.deepEqual(rowProblems(root, EXCEPTIONS), []);
});

const FLAGGED = [
  ["a fetch call", `const r = await ${FETCH}("https://example.test");\n`],
  ["globalThis fetch", `await globalThis.${FETCH}(url);\n`],
  ["the global fetch passed as a value", `const deps = { ${FETCH} };\n`],
  ["the global fetch passed as an argument", `createThing(${FETCH}, config);\n`],
  ["an undici import", `import { request } from "undici";\n`],
  ["an undici require", `const u = require("undici");\n`],
  ["a node:http request import", `import { request } from "node:http";\n`],
  ["a node:http get import", `import { get } from "node:http";\n`],
  ["an https request call", `import https from "node:https";\nhttps.request(options);\n`],
  ["a net connect call", `import net from "node:net";\nnet.connect(80, host);\n`],
  ["a tls connect call", `import tls from "node:tls";\ntls.connect(443, host);\n`],
  ["a dns resolveTxt call", `import dns from "node:dns";\ndns.resolveTxt(name, cb);\n`],
  ["a dns promises import", `import { resolveTxt } from "node:dns/promises";\n`],
  ["a new Resolver", `import { Resolver } from "node:dns/promises";\nnew Resolver().resolveTxt(name);\n`],
  ["a websocket", `const socket = new WebSocket(url);\n`],
  ["an S3 client import", `import { S3Client } from "@aws-sdk/client-s3";\n`],
  ["a nodemailer import", `import { createTransport } from "nodemailer";\n`],
  [
    "an OTLP exporter import",
    `import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";\n`,
  ],
  ["an OTLP exporter dynamic import", `const m = await import("@opentelemetry/exporter-trace-otlp-http");\n`],
  ["a default import of https", `import https from "node:https";\n`],
  ["a namespace import of net", `import * as net from "node:net";\n`],
  ["a bare module name", `import { connect } from "net";\n`],
  ["an Agent import from http", `import { Agent } from "node:http";\n`],
  ["a Socket import from net", `import { Socket } from "node:net";\n`],
  ["an aliased import from http", `import { createServer, request as send } from "node:http";\n`],
  ["a side-effect import of http", `import "node:http";\n`],
  ["a re-export from tls", `export { connect } from "node:tls";\n`],
  ["a dgram import", `import { createSocket } from "node:dgram";\n`],
  ["an http2 import", `import { connect } from "node:http2";\n`],
  ["a dynamic import of https", `const https = await import("node:https");\n`],
  ["a require of tls", `const tls = require("node:tls");\n`],
  ["a destructured require of net", `const { createConnection } = require("net");\n`],
  ["global.fetch", `await global.${FETCH}(url);\n`],
  ["self.fetch", `await self.${FETCH}(url);\n`],
  ["window.fetch", `await window.${FETCH}(url);\n`],
  ["globalThis by index", `await globalThis["${FETCH}"](url);\n`],
  ["fetch as a destructured name", `const { ${FETCH} } = globalThis;\n`],
  ["fetch destructured under another name", `const { ${FETCH}: send } = globalThis;\n`],
  ["fetch in a ternary", `const send = ok ? ${FETCH} : other;\n`],
  ["a // inside a string before the call", `const s = "a//b"; await ${FETCH}(url);\n`],
  ["a /* inside a string before the call", `const s = "/*"; await ${FETCH}(url); const e = "*/";\n`],
  ["a // inside a template before the call", `const s = \`//\`; await ${FETCH}(url);\n`],
  ["a // inside a regex before the call", `const r = /\\/\\//; await ${FETCH}(url);\n`],
  ["a call inside a template expression", `const s = \`\${await ${FETCH}(url)}\`;\n`],
];
for (const ext of EXTENSIONS) {
  FLAGGED.push([`a .${ext} file`, `await ${FETCH}(url);\n`, ext]);
}
FLAGGED.forEach(([title, content, ext = "ts"], index) => {
  const file = `apps/api/src/planted-${index}.${ext}`;
  test(`the scan flags a planted network use: ${title}`, () => {
    const base = plant({ [file]: content });
    try {
      assert.deepEqual(unlisted(base, []), [file]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

const SPARED = [
  ["a type-only import of http", "apps/api/src/a.ts", `import type { Server } from "node:http";\n`],
  ["a type-only import of net", "apps/api/src/b.ts", `import type { LookupFunction } from "node:net";\n`],
  [
    "isIP and BlockList",
    "apps/api/src/c.ts",
    `import { BlockList, isIP } from "node:net";\nisIP("1.2.3.4");\n`,
  ],
  ["createServer from node:http", "apps/api/src/d.ts", `import { createServer } from "node:http";\n`],
  [
    "every allowed binding, with an inline type and an alias",
    "apps/api/src/k.ts",
    `import { type Server, createServer as make } from "node:http";\nimport { isIPv4, isIPv6, SocketAddress } from "net";\n`,
  ],
  ["a type-only default import of https", "apps/api/src/l.ts", `import type https from "node:https";\n`],
  [
    "a property key after a comma",
    "apps/api/src/m.ts",
    `const h = { port: 1, ${FETCH}: handler };\nconst k = {\n  ${FETCH}: handler,\n};\n`,
  ],
  [
    "the word after a string with a comment marker",
    "apps/api/src/n.ts",
    `const s = "a//b"; // ${FETCH}(url) in a comment\n`,
  ],
  ["the egress client by name", "apps/api/src/e.ts", `await egressFetch(req, policy);\n`],
  ["typeof fetch in a type position", "apps/api/src/i.ts", `readonly ${FETCH}: typeof ${FETCH};\n`],
  [
    "the word in a string",
    "apps/api/src/j.ts",
    `h("sec-${FETCH}-site"); throw new TypeError("${FETCH} failed");\n`,
  ],
  ["a member named fetch", "apps/api/src/f.ts", `return app.${FETCH}(request);\n`],
  ["a property key named fetch", "apps/api/src/g.ts", `const h = { ${FETCH}: handler };\n`],
  [
    "a comment that names fetch",
    "apps/api/src/h.ts",
    `// never call ${FETCH}( here\n/* globalThis.${FETCH} */\n`,
  ],
  ["the egress directory", `${EGRESS_DIR}client.ts`, `import { request } from "undici";\n`],
  ["a test file", "apps/api/src/x.test.ts", `await ${FETCH}(url);\n`],
  ["a test folder", "packages/db/test/integration/x.ts", `await ${FETCH}(url);\n`],
  ["the testkit", "packages/testkit/src/simulator/x.ts", `await ${FETCH}(url);\n`],
  ["the web app", "apps/web/src/x.ts", `await ${FETCH}(url);\n`],
];
for (const [title, file, content] of SPARED) {
  test(`the scan spares ${title}`, () => {
    const base = plant({ [file]: content });
    try {
      assert.deepEqual(unlisted(base, []), []);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
}

test("a row listing a file clears that file, and a row naming a file with no network use fails", () => {
  const listed = "apps/api/src/mail/listed.ts";
  const clean = "apps/api/src/mail/clean.ts";
  const base = plant({
    [listed]: `import { createTransport } from "nodemailer";\n`,
    [clean]: "export const x = 1;\n",
  });
  try {
    const row = (path) => ({ id: "x", path, reason: "a reason" });
    assert.deepEqual(unlisted(base, [row(listed)]), []);
    assert.deepEqual(rowProblems(base, [row(listed)]), []);
    assert.deepEqual(rowProblems(base, [row(clean)]), [`${clean}: no network use`]);
    assert.deepEqual(rowProblems(base, [row("apps/api/src/gone.ts")]), [
      "apps/api/src/gone.ts: the file does not exist",
    ]);
    assert.deepEqual(rowProblems(base, [{ id: "x", path: listed, reason: " " }]), [`${listed}: no reason`]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
