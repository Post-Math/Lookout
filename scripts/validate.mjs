// Lightweight, dependency-free repo validation for CI.
// Checks required files exist, manifest.json / versions.json are valid and
// mutually consistent, and the version looks like x.y.z. Run AFTER the build
// (`npm run build`) so the bundled main.js exists.

import { readFileSync, existsSync } from "node:fs";

let failed = false;
const fail = (m) => {
  console.error("✗ " + m);
  failed = true;
};
const ok = (m) => console.log("✓ " + m);

for (const f of ["main.js", "manifest.json", "styles.css", "versions.json"]) {
  if (existsSync(f)) ok(`${f} present`);
  else fail(`${f} missing`);
}

let manifest = null;
let versions = null;
try {
  manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
  ok("manifest.json is valid JSON");
} catch (e) {
  fail("manifest.json invalid JSON: " + e.message);
}
try {
  versions = JSON.parse(readFileSync("versions.json", "utf8"));
  ok("versions.json is valid JSON");
} catch (e) {
  fail("versions.json invalid JSON: " + e.message);
}

if (manifest) {
  for (const k of ["id", "name", "version", "minAppVersion", "description", "author"]) {
    if (manifest[k]) ok(`manifest.${k} set`);
    else fail(`manifest.${k} missing`);
  }
  if (manifest.version && !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
    fail(`manifest.version "${manifest.version}" is not x.y.z`);
  }
}

if (manifest && versions) {
  if (versions[manifest.version]) {
    ok(`versions.json has an entry for ${manifest.version}`);
    if (manifest.minAppVersion && versions[manifest.version] !== manifest.minAppVersion) {
      fail(
        `versions["${manifest.version}"] (${versions[manifest.version]}) ` +
          `!= manifest.minAppVersion (${manifest.minAppVersion})`
      );
    }
  } else {
    fail(`versions.json is missing an entry for ${manifest.version}`);
  }
}

// package.json / package-lock.json carry the same version. Nothing reads it at
// runtime, which is exactly why it drifted unnoticed (stuck at 1.1.5 through
// 1.2.0–1.2.2); check it so a release bump can't forget it again.
if (manifest) {
  for (const f of ["package.json", "package-lock.json"]) {
    try {
      const v = JSON.parse(readFileSync(f, "utf8")).version;
      if (v === manifest.version) ok(`${f} version matches manifest (${v})`);
      else fail(`${f} version "${v}" != manifest.version "${manifest.version}"`);
    } catch (e) {
      fail(`${f} unreadable: ${e.message}`);
    }
  }
}

/*
 * styles.css: properties Obsidian's plugin CSS check rejects.
 *
 * That check maps each declared property to a caniuse feature and warns when
 * the feature is not *fully* supported by the Chrome in the plugin's
 * `minAppVersion`. The whole `text-decoration` family — shorthand and
 * longhands alike — resolves to one feature that Chrome only partially
 * supports, so no spelling of it passes; 1.2.1 shipped the longhands believing
 * only the shorthand was flagged, and got the same warning back. Use a
 * `border-bottom` for underline-like rules instead.
 *
 * This is a targeted guard, not a reimplementation of the reviewer's check:
 * it encodes the one family we have actually been flagged on.
 */
const CSS_BANNED = [
  [
    /(^|[;{\s])text-decoration(-line|-style|-color|-thickness|-skip|-skip-ink)?\s*:/gm,
    "Obsidian's CSS check flags the whole text-decoration family as only " +
      "partially supported. Use `border-bottom: 1px dotted currentColor` " +
      "(plus `padding-bottom` for offset) instead.",
  ],
];
if (existsSync("styles.css")) {
  const css = readFileSync("styles.css", "utf8");
  // Comments carry the explanation of *why* these are banned; don't self-trip.
  // Blank them out newline-for-newline so reported line numbers stay true.
  const code = css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
  let clean = true;
  for (const [re, why] of CSS_BANNED) {
    for (const m of code.matchAll(re)) {
      const line = code.slice(0, m.index).split("\n").length;
      fail(`styles.css:${line} uses \`${m[0].trim().replace(/:$/, "")}\`. ${why}`);
      clean = false;
    }
  }
  if (clean) ok("styles.css uses no unsupported browser features");
}

if (failed) {
  console.error("\nValidation failed.");
  process.exit(1);
}
console.log("\nAll checks passed.");
