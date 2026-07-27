/*
 * E2E regression test: the full-screen table must match the inline table's
 * design (theme styling) and layout (centering / override), and must carry a
 * cell's footnotes with it without leaking anything into the note behind it.
 *
 * It drives the REAL bundled plugin (main.js) in a headless browser with a tiny
 * `obsidian` stub, opens tables full screen, and inspects the result.
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
  // Obsidian's own DOM helpers. src/main.ts uses classList throughout, so
  // nothing needs these today; they are stubbed because they are real in the
  // app, and a stub that lacks them fails code the app would run fine — which
  // is exactly how the footnote jump path came to throw only under test.
  Element.prototype.addClass = function (c) { this.classList.add(c); };
  Element.prototype.removeClass = function (c) { this.classList.remove(c); };
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

  // Nothing the plugin does may throw. A silent TypeError used to abort
  // openFullscreen() mid-build with every assertion below still passing.
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push("pageerror: " + e.message));
  page.on("console", (m) => {
    if (m.type() === "error") pageErrors.push("console.error: " + m.text());
  });

  await page.goto(HARNESS);
  await page.addStyleTag({ content: STYLES });
  await page.addScriptTag({ content: bootstrap });
  await page.waitForSelector(".lookout-table-btn");

  // The dupe-id invariant, checked after every open. SVG-namespaced nodes are
  // skipped on purpose: `_scrub` preserves svg-internal ids because id-scoped
  // <style>/<use>/gradient references break without them, and a duplicated
  // svg-internal id is benign (same-document `url(#…)` resolves to an
  // identical definition).
  await page.evaluate(() => {
    window.__dupeIds = () => {
      const seen = new Set();
      const dupes = [];
      for (const node of document.querySelectorAll("[id]")) {
        if (node.namespaceURI === "http://www.w3.org/2000/svg") continue;
        if (seen.has(node.id)) dupes.push(node.id);
        seen.add(node.id);
      }
      return dupes;
    };
  });

  const openFs = async (sel) => {
    await page.locator(sel).click({ force: true });
    await page.waitForSelector(".lookout-table-fs-table");
  };
  const closeFs = async () => {
    await page.keyboard.press("Escape");
    await page.waitForSelector(".lookout-fs", { state: "detached" });
  };
  const dupes = () => page.evaluate(() => window.__dupeIds());

  /* ================= note-a, table 1: theme + layout parity ================= */
  await openFs("#note-a .lookout-table-btn >> nth=0");

  const r = await page.evaluate(() => {
    const g = (el, p) => (el ? getComputedStyle(el)[p] : null);
    const cell = (el) =>
      el && {
        borderTopWidth: g(el, "borderTopWidth"),
        borderTopStyle: g(el, "borderTopStyle"),
        paddingTop: g(el, "paddingTop"),
        paddingLeft: g(el, "paddingLeft"),
      };
    const inlineTd = document.querySelector("#note-a .lookout-table-scroll tbody td");
    const inlineTh = document.querySelector("#note-a .lookout-table-scroll thead th");
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
  check("no duplicate ids (plain table)", (await dupes()).length === 0);

  await closeFs();

  /* ============ note-a, table 2: footnote section, measure, jumps ============ */
  await openFs("#note-a .lookout-table-btn >> nth=1");
  await page.waitForSelector(".lookout-fs-footnotes li");

  const f = await page.evaluate(() => {
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    };
    const noteLi = document.querySelector("#note-a > .footnotes li");
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
      dupeIds: window.__dupeIds(),
      // The note's own definition is Obsidian-owned: read, never rewritten.
      noteLiUntouched:
        !!noteLi &&
        noteLi.id === "fn-1-d9" &&
        noteLi.getAttribute("data-footnote-id") === "fn-1-d9",
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

  // --- A4: right-click must not jump (auxclick fires for the secondary button).
  // (Chromium focuses the link itself on any mouse-down, so what must not
  // happen is focus landing on the *definition* — that would be our jump.)
  await page.evaluate(() => {
    window.__before = { scroll: document.scrollingElement.scrollTop };
  });
  await page.locator(".lookout-table-fs-table a.footnote-link").click({ button: "right" });
  const right = await page.evaluate(() => ({
    highlighted: document.querySelectorAll(".is-lookout-target").length,
    stoleFocus: !!document.activeElement?.closest(".lookout-fs-footnotes"),
    sameScroll: document.scrollingElement.scrollTop === window.__before.scroll,
  }));
  check("right-click on a marker does not jump", right.highlighted === 0 && !right.stoleFocus && right.sameScroll, JSON.stringify(right));

  // --- A4: middle-click still jumps.
  await page.locator(".lookout-table-fs-table a.footnote-link").click({ button: "middle" });
  check(
    "middle-click on a marker still jumps",
    (await page.evaluate(() => document.querySelectorAll(".is-lookout-target").length)) === 1
  );

  // --- A1/A5/E1: a plain click resolves the marker to its definition.
  await page.locator(".lookout-table-fs-table a.footnote-link").click();
  const jump = await page.evaluate(() => {
    const marker = document.querySelector(".lookout-table-fs-table a.footnote-link");
    const id = (marker.getAttribute("href") || "").slice(1);
    const li = document.getElementById(id);
    return {
      highlighted: document.querySelectorAll(".is-lookout-target").length,
      focusedTarget: !!li && document.activeElement === li,
      isLi: li?.tagName === "LI",
    };
  });
  check("marker click highlights exactly one target", jump.highlighted === 1, `count=${jump.highlighted}`);
  check("marker click focuses the definition li", jump.focusedTarget && jump.isLi, JSON.stringify(jump));

  // --- A2: the in-table back-ref jumps back; the paragraph's back-ref is dead.
  const backrefs = page.locator(".lookout-fs-footnotes a.footnote-backref");
  check("definition carries one back-ref per reference occurrence", (await backrefs.count()) === 2, `count=${await backrefs.count()}`);

  await backrefs.nth(0).click();
  const backJump = await page.evaluate(() => {
    const t = document.querySelector(".is-lookout-target");
    return { count: document.querySelectorAll(".is-lookout-target").length, tag: t?.tagName, cls: t?.className };
  });
  check(
    "in-table back-ref jumps to the marker's <sup>",
    backJump.count === 1 && backJump.tag === "SUP" && String(backJump.cls).includes("footnote-ref"),
    JSON.stringify(backJump)
  );

  const deadBefore = await page.evaluate(() => {
    const a = document.querySelectorAll(".lookout-fs-footnotes a.footnote-backref")[1];
    return {
      href: a.getAttribute("href"),
      role: a.getAttribute("role"),
      disabled: a.getAttribute("aria-disabled"),
      label: a.getAttribute("aria-label"),
      unresolved: a.classList.contains("lookout-fn-unresolved"),
      hash: location.hash,
      history: history.length,
    };
  });
  check(
    "out-of-table back-ref is inert and explained",
    deadBefore.href === null &&
      deadBefore.role === "link" &&
      deadBefore.disabled === "true" &&
      // A back-ref's visible text is the "↩︎" glyph, so its name says what is
      // missing rather than echoing a label that names nothing.
      deadBefore.label === "돌아갈 각주 참조가 이 화면에 없습니다" &&
      deadBefore.unresolved,
    JSON.stringify(deadBefore)
  );
  // `force`: Playwright refuses to click an `aria-disabled` element, which is
  // exactly what the hardening made it — the click still has to be delivered.
  await backrefs.nth(1).click({ force: true });
  const deadAfter = await page.evaluate(() => ({ hash: location.hash, history: history.length }));
  check(
    "clicking a dead back-ref changes neither the URL nor history",
    deadAfter.hash === deadBefore.hash && deadAfter.history === deadBefore.history,
    `${JSON.stringify(deadBefore)} -> ${JSON.stringify(deadAfter)}`
  );

  // --- D2: keyboard jump keeps a visible focus ring after the tint expires.
  await page.locator(".lookout-table-fs-table a.footnote-link").focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1700);
  const ring = await page.evaluate(() => {
    const li = document.activeElement;
    return {
      isLi: li?.tagName === "LI",
      tinted: document.querySelectorAll(".is-lookout-target").length,
      focusVisible: !!li && li.matches(":focus-visible"),
      outline: li ? getComputedStyle(li).outlineStyle : null,
    };
  });
  check(
    "keyboard jump leaves a visible focus indicator after the tint expires",
    ring.isLi && ring.tinted === 0 && ring.focusVisible && ring.outline !== "none",
    JSON.stringify(ring)
  );

  await closeFs();

  /* ================= note-b: no definitions anywhere (A3) ================= */
  const scrollBefore = await page.evaluate(() => document.scrollingElement.scrollTop);
  const hashBefore = await page.evaluate(() => location.hash);
  await openFs("#note-b .lookout-table-btn");
  const degraded = await page.evaluate(() => {
    const fsTable = document.querySelector(".lookout-table-fs-table");
    const anchors = [...fsTable.querySelectorAll("a.footnote-link")];
    return {
      hasDoc: !!document.querySelector(".lookout-fs-doc"),
      anchors: anchors.length,
      allInert: anchors.every(
        (a) =>
          !a.hasAttribute("href") &&
          a.getAttribute("aria-disabled") === "true" &&
          a.getAttribute("role") === "link" &&
          // The accessible name must CONTAIN the visible "[1]", not replace it.
          (a.getAttribute("aria-label") || "").includes(a.textContent.trim()) &&
          (a.getAttribute("aria-label") || "").includes("찾을 수 없습니다") &&
          a.classList.contains("lookout-fn-unresolved")
      ),
      leftovers: fsTable.querySelectorAll("[id], [data-footnote-id]").length,
      dupeIds: window.__dupeIds(),
    };
  });
  check("no footnote wrapper when nothing resolves", !degraded.hasDoc);
  check("every marker is inert when nothing resolves", degraded.anchors === 1 && degraded.allInert, JSON.stringify(degraded));
  check("no footnote identity survives in the degraded clone", degraded.leftovers === 0, `leftovers=${degraded.leftovers}`);
  check("no duplicate ids in the degraded clone", degraded.dupeIds.length === 0, `dupes=${degraded.dupeIds.join(",")}`);

  await page.locator(".lookout-table-fs-table a.footnote-link").click({ force: true });
  const after = await page.evaluate(() => ({
    hash: location.hash,
    scroll: document.scrollingElement.scrollTop,
  }));
  check(
    "clicking a degraded marker moves neither the URL nor the note behind it",
    after.hash === hashBefore && after.scroll === scrollBefore,
    `hash=${after.hash} scroll=${after.scroll} (was ${scrollBefore})`
  );
  await closeFs();

  /* ================= note-c: mixed note still builds (A1/F9) ================= */
  await openFs("#note-c .lookout-table-btn");
  await page.waitForSelector(".lookout-fs-footnotes li");
  const mixed = await page.evaluate(() => {
    const [ok, gone] = [...document.querySelectorAll(".lookout-table-fs-table a.footnote-link")];
    return {
      okHref: ok?.getAttribute("href"),
      goneHref: gone?.getAttribute("href"),
      goneRole: gone?.getAttribute("role"),
      goneDisabled: gone?.getAttribute("aria-disabled"),
      goneLabel: gone?.getAttribute("aria-label"),
      goneUnresolved: gone?.classList.contains("lookout-fn-unresolved"),
      defs: document.querySelectorAll(".lookout-fs-footnotes li").length,
      dupeIds: window.__dupeIds(),
    };
  });
  check("mixed note still builds its footnote section", mixed.defs === 1 && !!mixed.okHref?.startsWith("#lookout-fs-"), JSON.stringify(mixed));
  check(
    "the unresolvable marker is inert, named and role-restored",
    mixed.goneHref === null &&
      mixed.goneRole === "link" &&
      mixed.goneDisabled === "true" &&
      // Names the footnote it stands for ("[9]"), not just the failure.
      mixed.goneLabel?.includes("[9]") &&
      mixed.goneLabel?.includes("찾을 수 없습니다") &&
      mixed.goneUnresolved,
    JSON.stringify(mixed)
  );
  await page.locator(".lookout-table-fs-table a.footnote-link").first().click();
  check(
    "the resolvable marker in a mixed note still jumps",
    (await page.evaluate(() => document.querySelectorAll(".is-lookout-target").length)) === 1
  );
  check("no duplicate ids in a mixed note", mixed.dupeIds.length === 0, `dupes=${mixed.dupeIds.join(",")}`);
  await closeFs();

  /* ================= note-d: definitions emitted in note order (C1) ========= */
  await openFs("#note-d .lookout-table-btn");
  await page.waitForSelector(".lookout-fs-footnotes li");
  const order = await page.evaluate(() => ({
    values: [...document.querySelectorAll(".lookout-fs-footnotes li")].map((li) => li.value),
    // `li.value` is 0 without an explicit attribute, so the note's own list is
    // read as its ordinal positions — which is what the overlay must reproduce.
    noteValues: [...document.querySelectorAll("#note-d > .footnotes li")].map((li, i) => li.value || i + 1),
    markers: [...document.querySelectorAll(".lookout-table-fs-table a.footnote-link")].map((a) => a.textContent),
    dupeIds: window.__dupeIds(),
  }));
  check("footnote list ascends in the note's document order", JSON.stringify(order.values) === "[1,2]", JSON.stringify(order.values));
  check("the emitted order matches the note's own list", JSON.stringify(order.values) === JSON.stringify(order.noteValues), JSON.stringify(order.noteValues));
  check("markers keep their own numbering", JSON.stringify(order.markers) === JSON.stringify(["[2]", "[1]"]), JSON.stringify(order.markers));
  check("no duplicate ids with reordered footnotes", order.dupeIds.length === 0, `dupes=${order.dupeIds.join(",")}`);
  await closeFs();

  /* ================= note-e: svg-internal ids survive (B1) ================= */
  await openFs("#note-e .lookout-table-btn");
  const svgIds = await page.evaluate(() => {
    const fsTable = document.querySelector(".lookout-table-fs-table");
    const fsSvg = fsTable.querySelector("svg");
    const fsBox = fsTable.querySelector(".box");
    const noteBox = document.querySelector("#note-e .lookout-table-scroll .box");
    return {
      svgId: fsSvg?.getAttribute("id"),
      fsFill: fsBox ? getComputedStyle(fsBox).fill : null,
      noteFill: noteBox ? getComputedStyle(noteBox).fill : null,
      strayStripped: !fsTable.querySelector("#stray") && !!fsTable.querySelector("div"),
      dupeIds: window.__dupeIds(),
    };
  });
  check("svg-internal id survives the clone", svgIds.svgId === "probe-svg", `id=${svgIds.svgId}`);
  check("id-scoped svg styling still applies in the overlay", svgIds.fsFill === "rgb(0, 128, 0)" && svgIds.fsFill === svgIds.noteFill, `fs=${svgIds.fsFill} note=${svgIds.noteFill}`);
  check("an ordinary id in a cell is still stripped", svgIds.strayStripped);
  check("no duplicate non-svg ids with an svg in a cell", svgIds.dupeIds.length === 0, `dupes=${svgIds.dupeIds.join(",")}`);
  await closeFs();

  /* ========= note-f: a processed diagram in a definition is reset (B2) ====== */
  await openFs("#note-f .lookout-table-btn");
  await page.waitForSelector(".lookout-fs-footnotes li");
  const diagram = await page.evaluate(() => {
    const notes = document.querySelector(".lookout-fs-footnotes");
    const svg = notes.querySelector("svg");
    const sc = document.querySelector(".lookout-table-fs-scroll");
    return {
      w: svg?.style.width,
      h: svg?.style.height,
      mw: svg?.style.maxWidth,
      svgWidth: svg ? Math.round(svg.getBoundingClientRect().width) : null,
      notesWidth: Math.round(notes.getBoundingClientRect().width),
      scrollWidth: sc.scrollWidth,
      clientWidth: sc.clientWidth,
      chrome: notes.querySelectorAll(".lookout-viewport, .lookout-stage, .lookout-btn").length,
      dupeIds: window.__dupeIds(),
    };
  });
  check("cloned diagram loses the inline sizing DiagramView stamped on it", diagram.w === "" && diagram.h === "" && diagram.mw === "", JSON.stringify(diagram));
  check("cloned diagram fits inside the footnote section", diagram.svgWidth <= diagram.notesWidth, `svg=${diagram.svgWidth} notes=${diagram.notesWidth}`);
  check("a footnoted diagram adds no horizontal scroll", diagram.scrollWidth <= diagram.clientWidth + 1, `scrollWidth=${diagram.scrollWidth} clientWidth=${diagram.clientWidth}`);
  check("Lookout's own chrome is unwrapped out of the clone", diagram.chrome === 0, `chrome=${diagram.chrome}`);
  check("no duplicate ids with a diagram in a definition", diagram.dupeIds.length === 0, `dupes=${diagram.dupeIds.join(",")}`);
  await closeFs();

  /* ========= note-g: a very wide table keeps a readable measure (D3) ======== */
  await openFs("#note-g .lookout-table-btn");
  await page.waitForSelector(".lookout-fs-footnotes li");
  const wide = await page.evaluate(() => {
    const li = document.querySelector(".lookout-fs-footnotes li");
    const notes = document.querySelector(".lookout-fs-footnotes");
    const table = document.querySelector(".lookout-table-fs-table");
    return {
      liWidth: Math.round(li.getBoundingClientRect().width),
      notesWidth: Math.round(notes.getBoundingClientRect().width),
      tableWidth: Math.round(table.getBoundingClientRect().width),
      dupeIds: window.__dupeIds(),
    };
  });
  check("footnote prose on a wide table stays at a readable measure", wide.liWidth < 1000, `li=${wide.liWidth} table=${wide.tableWidth}`);
  check("the footnote divider still spans the wide table", Math.abs(wide.notesWidth - wide.tableWidth) <= 2, `notes=${wide.notesWidth} table=${wide.tableWidth}`);
  check("no duplicate ids on a wide table", wide.dupeIds.length === 0, `dupes=${wide.dupeIds.join(",")}`);
  await closeFs();

  /* ================= D1: focus restoration is keyboard-only ================= */
  // Mouse route: open and close with the pointer.
  await page.locator("#note-a .lookout-table-host").first().hover();
  await page.locator("#note-a .lookout-table-btn >> nth=0").click();
  await page.waitForSelector(".lookout-table-fs-table");
  await page.locator(".lookout-fs-close").click();
  await page.waitForSelector(".lookout-fs", { state: "detached" });
  await page.waitForTimeout(400);
  const mouse = await page.evaluate(() => {
    const a = document.activeElement;
    const isTrigger = !!a && a.classList.contains("lookout-table-btn");
    return { isTrigger, opacity: isTrigger ? getComputedStyle(a).opacity : null };
  });
  check(
    "a mouse close does not park focus on an invisible trigger",
    !mouse.isTrigger || mouse.opacity === "1",
    JSON.stringify(mouse)
  );
  await page.keyboard.press("Space");
  await page.waitForTimeout(200);
  check(
    "Space after a mouse close does not re-open full screen",
    (await page.locator(".lookout-fs").count()) === 0
  );

  // Keyboard route: open with Enter, close with Escape.
  await page.locator("#note-a .lookout-table-btn >> nth=0").focus();
  await page.keyboard.press("Enter");
  await page.waitForSelector(".lookout-table-fs-table");
  await closeFs();
  await page.waitForTimeout(200);
  const kbd = await page.evaluate(() => {
    const a = document.activeElement;
    const isTrigger = !!a && a.classList.contains("lookout-table-btn");
    return {
      isTrigger,
      focusVisible: isTrigger && a.matches(":focus-visible"),
      opacity: isTrigger ? getComputedStyle(a).opacity : null,
    };
  });
  check(
    "a keyboard close returns focus to a visible trigger",
    kbd.isTrigger && kbd.focusVisible && kbd.opacity === "1",
    JSON.stringify(kbd)
  );

  check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));
} finally {
  await browser.close();
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll E2E checks passed.");
