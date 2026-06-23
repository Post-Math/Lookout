// Lightweight, dependency-free repo validation for CI.
// Checks required files exist, manifest.json / versions.json are valid and
// mutually consistent, and the version looks like x.y.z. No build step.

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

if (failed) {
  console.error("\nValidation failed.");
  process.exit(1);
}
console.log("\nAll checks passed.");
