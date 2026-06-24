/*
 * E2E regression test for "fit to frame" on an inline Mermaid diagram (1.1.7).
 *
 * The default inline view opens at 100% (actual size, top-left); a tall diagram
 * legitimately overflows and pans there. The "fit" toolbar button must show the
 * WHOLE diagram with the frame height matching the fitted content — NO vertical
 * scroll — for both overflow shapes:
 *   · wide-and-tall (diagram-harness.html, 1600×1200) — width-bound
 *   · tall-and-narrow (diagram-tall-harness.html, 600×1900) — a sequenceDiagram
 *     shape whose width already fits the column (the reported regression).
 *
 * It drives the REAL bundled plugin (main.js) in a headless browser with a tiny
 * `obsidian` stub, exactly like table-fullscreen.test.mjs.
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
const fixture = (name) => "file://" + resolve(here, "fixtures", name);
const WIDE_TALL = fixture("diagram-harness.html");
const TALL_NARROW = fixture("diagram-tall-harness.html");

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

// Measure the inline viewport (the frame) against the stage (the transformed
// diagram). clientWidth/Height exclude the viewport's 1px border — the content
// box the diagram scrolls within — so comparisons stay border-agnostic. When
// the stage is taller than the content box, the diagram pans (vertical scroll).
const SAMPLE = `(() => {
  const vp = document.querySelector(".lookout-viewport:not(.lookout-viewport--fs)");
  const stage = document.querySelector(".lookout-viewport:not(.lookout-viewport--fs) .lookout-stage");
  const num = document.querySelector(".lookout-viewport:not(.lookout-viewport--fs) .lookout-gauge-num");
  const stR = stage.getBoundingClientRect();
  return {
    vpW: vp.clientWidth, vpH: vp.clientHeight,
    stageW: stR.width, stageH: stR.height,
    pct: parseInt(num.textContent, 10),
  };
})()`;

const inline = (sel) => `.lookout-viewport:not(.lookout-viewport--fs) ${sel}`;

// Open a fixture and wait until the inline view has wrapped the svg and applied
// its initial layout. The default view is 100% (identity transform, which
// computes to "none"), so we wait on the frame height being set instead.
async function open(page, harness) {
  await page.goto(harness);
  await page.addStyleTag({ content: STYLES });
  await page.addScriptTag({ content: bootstrap });
  await page.waitForSelector(inline(".lookout-stage"));
  await page.waitForFunction(() => {
    const vp = document.querySelector(
      ".lookout-viewport:not(.lookout-viewport--fs)"
    );
    return vp && vp.style.height && parseFloat(vp.style.height) > 0;
  });
}

// Click the "fit to frame" toolbar button and let its transition settle.
async function clickFit(page) {
  await page.click(inline('[aria-label="프레임에 맞추기"]'), { force: true });
  await page.waitForTimeout(280);
}

const exe = process.env.CHROMIUM_PATH;
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
try {
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  const cap = Math.round(800 * 0.7); // inline 70vh height cap at this window size

  // ===== Case A: wide-and-tall diagram =====
  await open(page, WIDE_TALL);
  const aLoad = await page.evaluate(SAMPLE);
  check("wide+tall: default inline view is 100%", aLoad.pct === 100, `gauge=${aLoad.pct}%`);

  await clickFit(page);
  const aFit = await page.evaluate(SAMPLE);
  check("wide+tall: fit scales below 100%", aFit.pct < 100, `gauge=${aFit.pct}%`);
  check(
    "wide+tall: fit frame height matches content (no vertical scroll)",
    aFit.stageH <= aFit.vpH + 1,
    `stageH=${aFit.stageH.toFixed(1)} vpH=${aFit.vpH.toFixed(1)}`
  );
  check(
    "wide+tall: fit fits the frame width too",
    aFit.stageW <= aFit.vpW + 1,
    `stageW=${aFit.stageW.toFixed(1)} vpW=${aFit.vpW.toFixed(1)}`
  );

  // ===== Case B: tall-and-narrow diagram (the reported regression) =====
  await open(page, TALL_NARROW);
  const bLoad = await page.evaluate(SAMPLE);
  check("tall+narrow: default inline view is 100%", bLoad.pct === 100, `gauge=${bLoad.pct}%`);
  check(
    "tall+narrow: at 100% the tall diagram overflows (pan available)",
    bLoad.stageH > bLoad.vpH + 1,
    `stageH=${bLoad.stageH.toFixed(1)} vpH=${bLoad.vpH.toFixed(1)}`
  );

  await clickFit(page);
  const bFit = await page.evaluate(SAMPLE);
  check("tall+narrow: fit scales below 100%", bFit.pct < 100, `gauge=${bFit.pct}%`);
  check(
    "tall+narrow: fit has NO vertical scroll despite tall shape (stage ≤ frame)",
    bFit.stageH <= bFit.vpH + 1,
    `stageH=${bFit.stageH.toFixed(1)} vpH=${bFit.vpH.toFixed(1)}`
  );
  check(
    "tall+narrow: fit frame stays within the 70vh cap",
    bFit.vpH <= cap + 1,
    `vpH=${bFit.vpH.toFixed(1)} cap=${cap}`
  );
} finally {
  await browser.close();
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll E2E checks passed.");
