import { readFileSync } from "node:fs";
import { join } from "node:path";
import { lingui } from "@lingui/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defaultClientConditions, defineConfig, type Plugin } from "vite";

function inlineThemeBootstrap(): Plugin {
  const source = () => readFileSync(join(import.meta.dirname, "src/theme/bootstrap.js"), "utf8");
  return {
    name: "shoutory:theme-bootstrap",
    transformIndexHtml: () => [{ tag: "script", children: source(), injectTo: "head-prepend" }],
  };
}

const root = join(import.meta.dirname, "../..");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };

export default defineConfig({
  // The About page links the source of the running version: a nightly image sets the commit it was built from.
  define: {
    "import.meta.env.SHOUTORY_VERSION": JSON.stringify(version),
    "import.meta.env.SHOUTORY_SOURCE_COMMIT": JSON.stringify(
      /^[0-9a-f]{7,40}$/.test(process.env.SHOUTORY_SOURCE_COMMIT ?? "")
        ? process.env.SHOUTORY_SOURCE_COMMIT
        : "",
    ),
  },
  // Lingui compiles the PO catalogs on import and transforms its macros itself, so react() needs no Babel step.
  // The config is found from this folder, so a build started from the repository root (the tests) finds it too.
  plugins: [
    react(),
    lingui({ macroTransform: true, cwd: import.meta.dirname }),
    tailwindcss(),
    inlineThemeBootstrap(),
  ],
  // Workspace packages are read from `src` through the `source` export condition, as in the tests.
  resolve: { conditions: [...defaultClientConditions, "source"] },
  build: {
    // Beside the type output of tsc (dist/tsc), so neither tool empties the other's folder.
    outDir: "dist/client",
    // The polyfill would add a second inline script to the page; only the theme bootstrap may be inline.
    modulePreload: { polyfill: false },
  },
});
