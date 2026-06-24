/*
 * E2E regression test: the full-screen table must match the inline table's
 * design (theme styling) and layout (centering / override).
 *
 * It drives the REAL bundled plugin (main.js) in a headless browser with a tiny
 * `obsidian` stub, opens a table full screen, and compares computed styles
 * against the inline table.
 *
 * Run:  npm run build && npm run test:e2e
 * Needs a Chromium once:  npx playwright install chromium
 *                         (or set CHROMIUM_PATH to an existing binary)
 */
import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const MAIN = readFileSync(resolve(root, "main.js"), "utf8");
const STYLES = readFileSync(resolve(root, "styles.css"), "utf8");
const HARNESS = "file://" + resolve(here, "fixtures", "table-harness.html");

// Load the bundled plugin under a minimal `obsidian` stub and start it.
const bootstrap = `
(function () {
  const __obsidian = {
    Plugin: class { constructor(app){ this.app = app; } registerEvent(){} registerMarkdownPostProcessor(){} addCommand(){} },
    Notice: class { constructor(m){ this.message = m; } },
  };
  const module = { exports: {} };
  const exports = module.exports;
  const require = (id) => { if (id === "obsidian") return __obsidian; throw new Error("unknown module: " + id); };
${MAIN}
  const LookoutPlugin = module.exports.default || module.exports;
  const app = { workspace: { onLayoutReady: (cb) => cb(), on: () => ({}) } };
  const plugin = new LookoutPlugin(app);
  plugin.onload();
})();
`;

const failures = [];
const check = (name, cond, detail) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
  if (!cond) failures.push(name);
};

const exe = process.env.CHROMIUM_PATH;
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
try {
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(HARNESS);
  await page.addStyleTag({ content: STYLES });
  await page.addScriptTag({ content: bootstrap });

  // The plugin enhanced the table on load; open it full screen.
  await page.waitForSelector(".lookout-table-btn");
  await page.click(".lookout-table-btn", { force: true });
  await page.waitForSelector(".lookout-table-fs-table");

  const r = await page.evaluate(() => {
    const g = (el, p) => (el ? getComputedStyle(el)[p] : null);
    const cell = (el) =>
      el && {
        borderTopWidth: g(el, "borderTopWidth"),
        borderTopStyle: g(el, "borderTopStyle"),
        paddingTop: g(el, "paddingTop"),
        paddingLeft: g(el, "paddingLeft"),
      };
    const inlineTd = document.querySelector(".lookout-table-scroll tbody td");
    const inlineTh = document.querySelector(".lookout-table-scroll thead th");
    const fsTd = document.querySelector(".lookout-table-fs-table tbody td");
    const fsTh = document.querySelector(".lookout-table-fs-table thead th");
    const fsTable = document.querySelector(".lookout-table-fs-table");
    const sc = document.querySelector(".lookout-table-fs-scroll");
    const tb = fsTable.getBoundingClientRect();
    const sb = sc.getBoundingClientRect();
    const cs = getComputedStyle(fsTable);
    return {
      inlineTd: cell(inlineTd),
      fsTd: cell(fsTd),
      inlineThBg: g(inlineTh, "backgroundColor"),
      fsThBg: g(fsTh, "backgroundColor"),
      overrideMargin: cs.marginTop,
      overrideMaxWidth: cs.maxWidth,
      tableVisible: tb.width > 0 && tb.height > 0,
      leftGap: Math.round(tb.left - sb.left),
      rightGap: Math.round(sb.right - tb.right),
    };
  });

  const sameCell = JSON.stringify(r.inlineTd) === JSON.stringify(r.fsTd);
  check("cell border/padding matches inline", sameCell, `inline=${JSON.stringify(r.inlineTd)} fs=${JSON.stringify(r.fsTd)}`);
  check("header background matches inline", r.inlineThBg === r.fsThBg, `inline=${r.inlineThBg} fs=${r.fsThBg}`);
  check("override styles intact (margin 0, max-width none)", r.overrideMargin === "0px" && r.overrideMaxWidth === "none", `margin=${r.overrideMargin} maxWidth=${r.overrideMaxWidth}`);
  check("full-screen table is visible", r.tableVisible);
  check("small table stays centered", Math.abs(r.leftGap - r.rightGap) <= 2, `gaps ${r.leftGap}/${r.rightGap}`);
} finally {
  await browser.close();
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll E2E checks passed.");
