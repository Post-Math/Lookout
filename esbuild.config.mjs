// esbuild bundles src/main.ts -> main.js at the repo root (Obsidian loads that
// file directly; there is no dist/). `node esbuild.config.mjs` watches for dev;
// `node esbuild.config.mjs production` does a one-shot minified build.
import esbuild from "esbuild";
import process from "process";
import { builtinModules } from "node:module";

const banner =
  "/*\n * Lookout — bundled output. Do not edit; edit the TypeScript source in\n * src/ and rebuild (see docs/DEVELOPMENT.md).\n */";

const production = process.argv[2] === "production";

const context = await esbuild.context({
  banner: { js: banner },
  entryPoints: ["src/main.ts"],
  bundle: true,
  // Obsidian and Electron are provided by the host; never bundle them.
  external: ["obsidian", "electron", ...builtinModules],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: production,
});

if (production) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
