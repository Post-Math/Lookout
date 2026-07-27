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
  // Obsidian runtime augmentations the bundle relies on (absent outside Obsidian).
  globalThis.activeWindow = window;
  globalThis.activeDocument = document;
  const _setCssStyles = function (styles) { Object.assign(this.style, styles); };
  const _setCssProps = function (props) { for (const k in props) this.style.setProperty(k, props[k]); };
  HTMLElement.prototype.setCssStyles = _setCssStyles;
  HTMLElement.prototype.setCssProps = _setCssProps;
  SVGElement.prototype.setCssStyles = _setCssStyles;
  SVGElement.prototype.setCssProps = _setCssProps;
  Node.prototype.instanceOf = function (t) { return this instanceof t; };
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

  // The plugin enhanced the tables on load; open the first one full screen.
  await page.waitForSelector(".lookout-table-btn");
  await page.locator(".lookout-table-btn").first().click({ force: true });
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

  // ---- Footnotes: the second (narrow) table carries an inline-footnote marker.
  await page.keyboard.press("Escape");
  await page.waitForSelector(".lookout-fs", { state: "detached" });
  await page.locator(".lookout-table-btn").nth(1).click({ force: true });
  await page.waitForSelector(".lookout-fs-footnotes li");

  const f = await page.evaluate(() => {
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    };
    const noteLi = document.querySelector(".markdown-rendered > .footnotes li");
    const fsLi = document.querySelector(".lookout-fs-footnotes li");
    const fsTable = document.querySelector(".lookout-table-fs-table");
    const sc = document.querySelector(".lookout-table-fs-scroll");
    const tb = fsTable.getBoundingClientRect();
    const sb = sc.getBoundingClientRect();
    return {
      noteLi: box(noteLi),
      fsLi: box(fsLi),
      fsTableWidth: Math.round(tb.width),
      leftGap: Math.round(tb.left - sb.left),
      rightGap: Math.round(sb.right - tb.right),
      // The definition text must survive the clone.
      fsText: (fsLi?.textContent || "").trim().slice(0, 20),
      markerHref: document
        .querySelector(".lookout-table-fs-table a.footnote-link")
        ?.getAttribute("href"),
      // The clone must never mint an id the note already uses.
      dupeIds: (() => {
        const seen = new Set();
        const dupes = [];
        for (const node of document.querySelectorAll("[id]")) {
          if (seen.has(node.id)) dupes.push(node.id);
          seen.add(node.id);
        }
        return dupes;
      })(),
      // The note's own definition is Obsidian-owned: read, never rewritten.
      noteLiUntouched:
        !!noteLi &&
        !noteLi.id &&
        noteLi.getAttribute("data-footnote-id") === "fn-1",
    };
  });

  check("footnote definition is carried into full screen", f.fsText.startsWith("A perfectly ordinary"), `text="${f.fsText}"`);
  check("footnote marker points at an overlay-local anchor", !!f.markerHref?.startsWith("#lookout-fs-"), `href=${f.markerHref}`);
  // The regression this guards: sizing the section to the narrow table's own
  // width squeezed the text into a one-word-per-line ribbon.
  check(
    "footnote text reads at a note-like measure, not the table's width",
    f.fsLi.w >= Math.min(f.noteLi.w, 400) && f.fsLi.w > f.fsTableWidth * 2,
    `note=${f.noteLi.w}x${f.noteLi.h} fs=${f.fsLi.w}x${f.fsLi.h} table=${f.fsTableWidth}`
  );
  check("footnote text is not stacked into a sliver", f.fsLi.h <= f.noteLi.h * 2, `note h=${f.noteLi.h} fs h=${f.fsLi.h}`);
  check("narrow table with footnotes stays centered", Math.abs(f.leftGap - f.rightGap) <= 2, `gaps ${f.leftGap}/${f.rightGap}`);
  check("no duplicate ids introduced by the clone", f.dupeIds.length === 0, `dupes=${f.dupeIds.join(",")}`);
  check("the note's own footnote definition is left untouched", f.noteLiUntouched);
} finally {
  await browser.close();
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll E2E checks passed.");
