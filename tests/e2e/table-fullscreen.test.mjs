/*
 * E2E regression test: the full-screen table must match the inline table's
 * design (theme styling) and layout (centering / override), and must carry a
 * cell's footnotes with it — resolved from the note's SOURCE, not from rendered
 * DOM — without leaking anything into the note behind it.
 *
 * It drives the REAL bundled plugin (main.js) in a headless browser with a tiny
 * `obsidian` stub, opens tables full screen, and inspects the result.
 *
 * The stub deliberately fakes the whole resolution chain (metadataCache →
 * cachedRead → MarkdownRenderer) rather than the rendered `.footnotes` list the
 * previous suite assumed: a real vault does not have that list in the DOM for
 * any table but the note's last one, and encoding the assumption in the harness
 * is exactly how the original bug shipped green.
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
  // Obsidian's DOM helper, faithful to the real signature: the second argument
  // is a class string or a DomElementInfo. A stub shaped to whatever the code
  // happens to ask for is how a green suite hid a broken feature before.
  globalThis.createEl = function (tag, o, cb) {
    const node = document.createElement(tag);
    if (typeof o === "string") o = { cls: o };
    if (o) {
      if (o.cls) node.className = Array.isArray(o.cls) ? o.cls.join(" ") : o.cls;
      if (o.text) node.textContent = o.text;
      if (o.attr) for (const k in o.attr) node.setAttribute(k, o.attr[k]);
      if (o.title) node.title = o.title;
      if (o.parent) o.prepend ? o.parent.prepend(node) : o.parent.appendChild(node);
    }
    if (cb) cb(node);
    return node;
  };
  Node.prototype.createEl = function (tag, o, cb) {
    if (typeof o === "string") o = { cls: o };
    o = o || {};
    o.parent = this;
    return globalThis.createEl(tag, o, cb);
  };
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

  window.__componentsLoaded = 0;
  window.__componentsUnloaded = 0;
  window.__renderCalls = [];
  window.__linkResolutions = [];
  window.__readCalls = [];
  window.__gateRead = false;
  window.__pageErrors = [];
  window.addEventListener("unhandledrejection", (e) => {
    window.__pageErrors.push("unhandledrejection: " + (e.reason && e.reason.message || e.reason));
  });

  // --- Component: load/unload with counters, plus child bookkeeping. ---
  class Component {
    constructor() { this._children = []; this._cbs = []; this._loaded = false; }
    load() {
      if (this._loaded) return;
      this._loaded = true;
      window.__componentsLoaded++;
      this.onload();
    }
    onload() {}
    unload() {
      if (!this._loaded) return;
      this._loaded = false;
      window.__componentsUnloaded++;
      for (const c of this._children.splice(0)) c.unload();
      for (const cb of this._cbs.splice(0)) cb();
      this.onunload();
    }
    onunload() {}
    register(cb) { this._cbs.push(cb); }
    registerEvent() {}
    addChild(c) { this._children.push(c); c.load(); return c; }
    removeChild(c) {
      const i = this._children.indexOf(c);
      if (i >= 0) this._children.splice(i, 1);
      c.unload();
      return c;
    }
  }

  class TFile { constructor(path) { this.path = path; } }
  class View { constructor(containerEl, file) { this.containerEl = containerEl; this.file = file; } }
  class MarkdownView extends View {}

  /*
   * A deliberately small markdown renderer with just enough fidelity for the
   * properties under test:
   *   - blank-line separated paragraphs become <p>, so back-ref placement is
   *     exercised against a real block child;
   *   - a fence at COLUMN 0 becomes <pre><code class="language-…">, while a
   *     4-space/tab indented block becomes a plain <pre><code>. Without that
   *     distinction the dedent regression would be invisible;
   *   - [text](target) becomes an internal link, so the "a link inside a
   *     footnote closes full screen and navigates" path is reachable;
   *   - "### 제목" becomes <h3 id="…"> and a trailing " ^block-id" stamps that
   *     id on the paragraph. A renderer that never emits an id would make the
   *     clone's id hygiene unobservable — the same "the stub returns only what
   *     the implementation handles" trap that let the original bug ship green.
   */
  const inline = (node, text) => {
    const re = /\\[([^\\]]+)\\]\\(([^)]+)\\)/g;
    let last = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) node.appendChild(document.createTextNode(text.slice(last, m.index)));
      const a = document.createElement("a");
      a.className = "internal-link";
      a.setAttribute("href", m[2]);
      a.textContent = m[1];
      node.appendChild(a);
      last = re.lastIndex;
    }
    if (last < text.length) node.appendChild(document.createTextNode(text.slice(last)));
  };
  const codeBlock = (elm, body, lang) => {
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    if (lang) code.className = "language-" + lang;
    code.textContent = body;
    pre.appendChild(code);
    elm.appendChild(pre);
  };
  const isIndented = (line) => line.startsWith("    ") || line.startsWith("\\t");

  class MarkdownRenderer {
    static async render(app, markdown, elm, sourcePath, component) {
      window.__renderCalls.push({ sourcePath, markdown, component: !!component });
      await Promise.resolve();
      const lines = String(markdown).split("\\n");
      let i = 0;
      while (i < lines.length) {
        const line = lines[i];
        if (line.startsWith("\`\`\`")) {
          const lang = line.slice(3).trim();
          const body = [];
          i++;
          while (i < lines.length && !lines[i].startsWith("\`\`\`")) { body.push(lines[i]); i++; }
          i++;
          codeBlock(elm, body.join("\\n"), lang);
          continue;
        }
        if (isIndented(line)) {
          const body = [];
          while (i < lines.length && (isIndented(lines[i]) || lines[i].trim() === "")) {
            body.push(lines[i].replace(/^(    |\\t)/, ""));
            i++;
          }
          while (body.length && body[body.length - 1].trim() === "") body.pop();
          codeBlock(elm, body.join("\\n"), "");
          continue;
        }
        if (line.trim() === "") { i++; continue; }
        if (/^#{1,6} /.test(line)) {
          const level = line.match(/^#+/)[0].length;
          const text = line.slice(level + 1).trim();
          const h = document.createElement("h" + level);
          h.id = "h-" + text.replace(/\\s+/g, "-");
          h.textContent = text;
          elm.appendChild(h);
          i++;
          continue;
        }
        const buf = [];
        while (i < lines.length && lines[i].trim() !== "" && !lines[i].startsWith("\`\`\`") && !isIndented(lines[i]) && !/^#{1,6} /.test(lines[i])) {
          buf.push(lines[i]);
          i++;
        }
        const p = document.createElement("p");
        let body = buf.join(" ");
        const block = /\\s\\^([A-Za-z0-9-]+)$/.exec(body);
        if (block) {
          p.id = block[1];
          body = body.slice(0, block.index);
        }
        inline(p, body);
        elm.appendChild(p);
      }
    }
  }

  const __obsidian = {
    Plugin: class { constructor(app){ this.app = app; } registerEvent(){} registerMarkdownPostProcessor(){} addCommand(){} },
    Notice: class { constructor(m){ this.message = m; } },
    Component,
    MarkdownRenderer,
    MarkdownView,
    TFile,
  };
  const module = { exports: {} };
  const exports = module.exports;
  const require = (id) => { if (id === "obsidian") return __obsidian; throw new Error("unknown module: " + id); };
${MAIN}
  const LookoutPlugin = module.exports.default || module.exports;

  const files = new Map();
  const fileFor = (path) => {
    if (!files.has(path)) files.set(path, new TFile(path));
    return files.get(path);
  };
  const app = {
    workspace: {
      onLayoutReady: (cb) => cb(),
      on: () => ({}),
      // A real leaf per note root, so the actual leaf -> file walk is exercised.
      // \`getActiveFile\` is deliberately NOT stubbed: if the implementation ever
      // reaches for it, this suite must break.
      getLeavesOfType: (type) => {
        if (type !== "markdown") return [];
        return Array.from(document.querySelectorAll("[data-note-file]")).map((rootEl) => ({
          view: new MarkdownView(rootEl, fileFor(rootEl.getAttribute("data-note-file"))),
        }));
      },
    },
    metadataCache: {
      getFileCache: (file) => {
        const note = window.__NOTES[file.path];
        if (!note || note.cache === null) return null;
        return {
          footnotes: (note.footnotes || []).map((f) => {
            // Offsets derived from the fixture's own source by indexOf, so they
            // can never drift from the text — unless the fixture asks them to.
            // \`shift\`/\`endShift\` reproduce a metadata index lagging the file
            // content, the one case where the cache names a region that is not
            // the footnote (or is not in the file at all).
            const at = note.source.indexOf(f.slice);
            if (at < 0) throw new Error("fixture: slice for " + f.id + " is not in " + file.path);
            const start = at + (f.shift || 0);
            return {
              id: f.id,
              position: {
                start: { line: 0, col: 0, offset: start },
                end: { line: 0, col: 0, offset: start + f.slice.length + (f.endShift || 0) },
              },
            };
          }),
        };
      },
      getFirstLinkpathDest: (linkpath, sourcePath) => {
        window.__linkResolutions.push({ linkpath, sourcePath });
        const path = linkpath.endsWith(".md") ? linkpath : linkpath + ".md";
        return window.__NOTES[path] ? fileFor(path) : null;
      },
    },
    vault: {
      cachedRead: (file) => {
        window.__readCalls.push(file.path);
        const note = window.__NOTES[file.path] || {};
        const src = note.source || "";
        if (!window.__gateRead) return Promise.resolve(src);
        return new Promise((res) => { window.__releaseRead = () => res(src); });
      },
    },
  };
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
  // openFullscreen() mid-build with every assertion below still passing; with an
  // async resolution path a *rejected promise* is the same hazard, so in-page
  // unhandled rejections are drained into the same list.
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

  const SETTLED = '.lookout-fs[data-lookout-fn="ready"], .lookout-fs[data-lookout-fn="none"]';
  const openFs = async (sel) => {
    await page.locator(sel).click({ force: true });
    await page.waitForSelector(".lookout-table-fs-table");
  };
  // Every footnote assertion must be gated on the SETTLED state: the table
  // clone is in the DOM before the definitions are resolved, so an assertion
  // made on `.lookout-table-fs-table` alone would read pre-settle DOM and pass
  // no matter what the resolution did.
  const openFsSettled = async (sel) => {
    await openFs(sel);
    await page.waitForSelector(SETTLED);
  };
  const closeFs = async () => {
    await page.keyboard.press("Escape");
    await page.waitForSelector(".lookout-fs", { state: "detached" });
  };
  const dupes = () => page.evaluate(() => window.__dupeIds());
  const fnState = () =>
    page.evaluate(() => document.querySelector(".lookout-fs")?.getAttribute("data-lookout-fn"));

  /* ================= note-a, table 1: theme + layout parity ================= */
  await openFs("#note-a .lookout-table-btn >> nth=0");

  const r = await page.evaluate(() => {
    const g = (elm, p) => (elm ? getComputedStyle(elm)[p] : null);
    const cell = (elm) =>
      elm && {
        borderTopWidth: g(elm, "borderTopWidth"),
        borderTopStyle: g(elm, "borderTopStyle"),
        paddingTop: g(elm, "paddingTop"),
        paddingLeft: g(elm, "paddingLeft"),
      };
    const inlineTd = document.querySelector("#note-a .lookout-table-scroll tbody td");
    const inlineTh = document.querySelector("#note-a .lookout-table-scroll thead th");
    const fsTd = document.querySelector(".lookout-table-fs-table tbody td");
    const fsTh = document.querySelector(".lookout-table-fs-table thead th");
    const fsTable = document.querySelector(".lookout-table-fs-table");
    const sc = document.querySelector(".lookout-table-fs-scroll");
    const overlay = document.querySelector(".lookout-fs");
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
      // (xiv) byte-identical overlay for a table with no footnote anchors.
      hasSettleAttr: overlay.hasAttribute("data-lookout-fn"),
      hasDoc: !!document.querySelector(".lookout-fs-doc"),
      tableIsDirectChild: fsTable.parentElement === sc,
    };
  });

  const sameCell = JSON.stringify(r.inlineTd) === JSON.stringify(r.fsTd);
  check("cell border/padding matches inline", sameCell, `inline=${JSON.stringify(r.inlineTd)} fs=${JSON.stringify(r.fsTd)}`);
  check("header background matches inline", r.inlineThBg === r.fsThBg, `inline=${r.inlineThBg} fs=${r.fsThBg}`);
  check("override styles intact (margin 0, max-width none)", r.overrideMargin === "0px" && r.overrideMaxWidth === "none", `margin=${r.overrideMargin} maxWidth=${r.overrideMaxWidth}`);
  check("full-screen table is visible", r.tableVisible);
  check("small table stays centered", Math.abs(r.leftGap - r.rightGap) <= 2, `gaps ${r.leftGap}/${r.rightGap}`);
  check(
    "a table with no footnotes builds the pre-footnote overlay exactly",
    !r.hasSettleAttr && !r.hasDoc && r.tableIsDirectChild,
    JSON.stringify(r)
  );
  check("no duplicate ids (plain table)", (await dupes()).length === 0);

  await closeFs();

  /* ===== (i) THE REGRESSION: a note with NO rendered .footnotes anywhere ===== */
  await openFsSettled("#note-a .lookout-table-btn >> nth=1");

  const reg = await page.evaluate(() => {
    const box = (elm) => {
      if (!elm) return null;
      const rect = elm.getBoundingClientRect();
      return { w: Math.round(rect.width), h: Math.round(rect.height) };
    };
    const lis = Array.from(document.querySelectorAll(".lookout-fs-footnotes li"));
    const fsLi = lis[0];
    const fsTable = document.querySelector(".lookout-table-fs-table");
    const sc = document.querySelector(".lookout-table-fs-scroll");
    const marker = document.querySelector(".lookout-table-fs-table a.footnote-link");
    const liveMarker = document.querySelector("#note-a #fn-table a.footnote-link");
    const tb = fsTable.getBoundingClientRect();
    const sb = sc.getBoundingClientRect();
    return {
      state: document.querySelector(".lookout-fs").getAttribute("data-lookout-fn"),
      count: lis.length,
      text: (fsLi?.textContent || "").replace("↩︎", "").trim(),
      value: fsLi?.value,
      liId: fsLi?.id,
      liFootnoteId: fsLi?.getAttribute("data-footnote-id"),
      markerHref: marker?.getAttribute("href"),
      // (xiii) target/rel are real in the vault and must not survive the clone,
      // or a click in full screen opens a browser window. The note's own marker
      // keeps them: Lookout never touches the live DOM.
      cloneTarget: marker?.getAttribute("target"),
      cloneRel: marker?.getAttribute("rel"),
      liveTarget: liveMarker?.getAttribute("target"),
      liveRel: liveMarker?.getAttribute("rel"),
      // Obsidian gives a footnote no hover affordance of its own, and the
      // definition can sit far below a long table, so the marker carries the
      // definition text as a native tooltip — without the back-ref glyph.
      markerTitle: marker?.getAttribute("title"),
      liveMarkerTitle: liveMarker?.getAttribute("title"),
      fsLi: box(fsLi),
      fsTableWidth: Math.round(tb.width),
      leftGap: Math.round(tb.left - sb.left),
      rightGap: Math.round(sb.right - tb.right),
      dupeIds: window.__dupeIds(),
    };
  });

  check(
    "a definition is resolved from the note SOURCE with no .footnotes in the DOM",
    reg.state === "ready" && reg.count === 1 && reg.text === "표와 문단 양쪽에서 참조되는 각주.",
    JSON.stringify({ state: reg.state, count: reg.count, text: reg.text })
  );
  check("the `[^ref]:` label is stripped from the rendered body", !reg.text.includes("[^ref]"), reg.text);
  check("the definition keeps the marker's number", reg.value === 1, `value=${reg.value}`);
  check(
    "hovering a resolved marker previews the definition",
    reg.markerTitle === "표와 문단 양쪽에서 참조되는 각주." && !reg.markerTitle.includes("↩︎"),
    `title=${JSON.stringify(reg.markerTitle)}`
  );
  check(
    "the note's own marker is left without a tooltip",
    reg.liveMarkerTitle === null,
    `liveTitle=${JSON.stringify(reg.liveMarkerTitle)}`
  );
  check("footnote marker points at an overlay-local anchor", !!reg.markerHref?.startsWith("#lookout-fs-"), `href=${reg.markerHref}`);
  check("the emitted li keeps its namespaced id through _scrub", reg.liId === reg.markerHref?.slice(1) && reg.liFootnoteId === reg.liId, JSON.stringify({ liId: reg.liId, href: reg.markerHref }));
  check(
    "target/rel are stripped from the clone but kept on the note's own marker",
    reg.cloneTarget === null && reg.cloneRel === null && reg.liveTarget === "_blank" && reg.liveRel === "noopener nofollow",
    JSON.stringify(reg)
  );
  // The regression this guards: sizing the section to the narrow table's own
  // width squeezed the text into a one-word-per-line ribbon.
  check(
    "footnote text reads at a note-like measure, not the table's width",
    reg.fsLi.w >= 400 && reg.fsLi.w > reg.fsTableWidth * 2,
    `fs=${reg.fsLi.w}x${reg.fsLi.h} table=${reg.fsTableWidth}`
  );
  check("footnote text is not stacked into a sliver", reg.fsLi.h <= 60, `fs h=${reg.fsLi.h}`);
  check("narrow table with footnotes stays centered", Math.abs(reg.leftGap - reg.rightGap) <= 2, `gaps ${reg.leftGap}/${reg.rightGap}`);
  check("no duplicate ids introduced by the clone", reg.dupeIds.length === 0, `dupes=${reg.dupeIds.join(",")}`);

  // --- right-click must not jump (auxclick fires for the secondary button).
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

  // --- middle-click still jumps.
  await page.locator(".lookout-table-fs-table a.footnote-link").click({ button: "middle" });
  check(
    "middle-click on a marker still jumps",
    (await page.evaluate(() => document.querySelectorAll(".is-lookout-target").length)) === 1
  );

  // --- a plain click resolves the marker to its definition.
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

  // --- one back-ref per occurrence PRESENT IN THE CLONE. The same footnote is
  // referenced again from the paragraph below the table; that occurrence's
  // <sup> never enters the overlay, so it must produce no back-ref at all — a
  // dead back-ref is designed out, not merely made inert.
  const backrefs = page.locator(".lookout-fs-footnotes a.footnote-backref");
  check("only in-clone occurrences produce a back-ref", (await backrefs.count()) === 1, `count=${await backrefs.count()}`);
  const backMeta = await page.evaluate(() => {
    const a = document.querySelector(".lookout-fs-footnotes a.footnote-backref");
    const p = a.parentElement;
    return {
      href: a.getAttribute("href"),
      label: a.getAttribute("aria-label"),
      inert: a.classList.contains("lookout-fn-unresolved"),
      inParagraph: p.tagName === "P",
    };
  });
  check(
    "the back-ref is live, named and sits with the definition text",
    backMeta.href?.startsWith("#lookout-fs-") &&
      !backMeta.inert &&
      backMeta.label?.includes("각주 1") &&
      backMeta.inParagraph,
    JSON.stringify(backMeta)
  );

  await backrefs.nth(0).click();
  const backJump = await page.evaluate(() => {
    const t = document.querySelector(".is-lookout-target");
    return { count: document.querySelectorAll(".is-lookout-target").length, tag: t?.tagName, cls: t?.className };
  });
  check(
    "the back-ref jumps to the marker's <sup>",
    backJump.count === 1 && backJump.tag === "SUP" && String(backJump.cls).includes("footnote-ref"),
    JSON.stringify(backJump)
  );

  // --- keyboard jump keeps a visible focus ring after the tint expires.
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

  /* ================= (vii) note-b: the file has no cache ================= */
  const scrollBefore = await page.evaluate(() => document.scrollingElement.scrollTop);
  const hashBefore = await page.evaluate(() => location.hash);
  const historyBefore = await page.evaluate(() => history.length);
  await openFsSettled("#note-b .lookout-table-btn");
  const nocache = await page.evaluate(() => {
    const fsTable = document.querySelector(".lookout-table-fs-table");
    const anchors = Array.from(fsTable.querySelectorAll("a.footnote-link"));
    return {
      state: document.querySelector(".lookout-fs").getAttribute("data-lookout-fn"),
      section: document.querySelectorAll(".lookout-fs-footnotes").length,
      anchors: anchors.length,
      allInert: anchors.every(
        (a) =>
          !a.hasAttribute("href") &&
          !a.hasAttribute("target") &&
          !a.hasAttribute("rel") &&
          a.getAttribute("aria-disabled") === "true" &&
          a.getAttribute("role") === "link" &&
          // The accessible name must CONTAIN the visible "[1]", not replace it.
          (a.getAttribute("aria-label") || "").includes(a.textContent.trim()) &&
          (a.getAttribute("aria-label") || "").includes("찾을 수 없습니다") &&
          a.classList.contains("lookout-fn-unresolved")
      ),
      dupeIds: window.__dupeIds(),
    };
  });
  check("a file with no metadata cache settles to 'none'", nocache.state === "none" && nocache.section === 0, JSON.stringify(nocache));
  check("every marker is inert when nothing resolves", nocache.anchors === 1 && nocache.allInert, JSON.stringify(nocache));
  check("no duplicate ids in the degraded clone", nocache.dupeIds.length === 0, `dupes=${nocache.dupeIds.join(",")}`);

  await page.locator(".lookout-table-fs-table a.footnote-link").click({ force: true });
  const after = await page.evaluate(() => ({
    hash: location.hash,
    scroll: document.scrollingElement.scrollTop,
    history: history.length,
  }));
  check(
    "clicking a degraded marker moves neither the URL, the history nor the note behind it",
    after.hash === hashBefore && after.scroll === scrollBefore && after.history === historyBefore,
    `hash=${after.hash} scroll=${after.scroll} history=${after.history}`
  );
  await closeFs();

  /* ============ (vi) note-c: one label unknown, the rest still builds ======== */
  await openFsSettled("#note-c .lookout-table-btn");
  const mixed = await page.evaluate(() => {
    const [ok, gone] = Array.from(document.querySelectorAll(".lookout-table-fs-table a.footnote-link"));
    return {
      state: document.querySelector(".lookout-fs").getAttribute("data-lookout-fn"),
      okHref: ok?.getAttribute("href"),
      goneHref: gone?.getAttribute("href"),
      goneRole: gone?.getAttribute("role"),
      goneDisabled: gone?.getAttribute("aria-disabled"),
      goneLabel: gone?.getAttribute("aria-label"),
      goneUnresolved: gone?.classList.contains("lookout-fn-unresolved"),
      defs: document.querySelectorAll(".lookout-fs-footnotes li").length,
      text: (document.querySelector(".lookout-fs-footnotes li")?.textContent || "").replace("↩︎", "").trim(),
      dupeIds: window.__dupeIds(),
    };
  });
  check(
    "one unknown label does not collapse the section",
    mixed.state === "ready" && mixed.defs === 1 && mixed.text === "이 노트가 정의한 유일한 각주." && !!mixed.okHref?.startsWith("#lookout-fs-"),
    JSON.stringify(mixed)
  );
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

  /* ======== (x) note-d: a non-1-based subset, sorted ascending ============== */
  await openFsSettled("#note-d .lookout-table-btn");
  const order = await page.evaluate(() => ({
    values: Array.from(document.querySelectorAll(".lookout-fs-footnotes li")).map((li) => li.value),
    texts: Array.from(document.querySelectorAll(".lookout-fs-footnotes li")).map((li) =>
      li.textContent.replace("↩︎", "").trim()
    ),
    markers: Array.from(document.querySelectorAll(".lookout-table-fs-table a.footnote-link")).map((a) => a.textContent),
    dupeIds: window.__dupeIds(),
  }));
  check("the emitted list is the marker's own numbering, ascending", JSON.stringify(order.values) === "[3,5]", JSON.stringify(order.values));
  check("markers keep their own numbering and reference order", JSON.stringify(order.markers) === JSON.stringify(["[5]", "[3]"]), JSON.stringify(order.markers));
  check(
    "each number carries its own definition",
    order.texts[0] === "앞선 문단이 먼저 참조해 낮은 번호를 받는다." && order.texts[1] === "표 안에서만 참조되므로 더 높은 번호를 받는다.",
    JSON.stringify(order.texts)
  );
  check("no duplicate ids with a reordered subset", order.dupeIds.length === 0, `dupes=${order.dupeIds.join(",")}`);
  await closeFs();

  /* ================= note-e: svg-internal ids survive ================= */
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

  /* ====== note-f: a processed diagram in a CELL loses its inline sizing ===== */
  await openFs("#note-f .lookout-table-btn");
  const diagram = await page.evaluate(() => {
    const fsTable = document.querySelector(".lookout-table-fs-table");
    const svg = fsTable.querySelector("svg");
    const sc = document.querySelector(".lookout-table-fs-scroll");
    return {
      w: svg?.style.width,
      h: svg?.style.height,
      mw: svg?.style.maxWidth,
      chrome: fsTable.querySelectorAll(".lookout-viewport, .lookout-stage, .lookout-btn").length,
      dupeIds: window.__dupeIds(),
    };
  });
  check("cloned diagram loses the inline sizing DiagramView stamped on it", diagram.w === "" && diagram.h === "" && diagram.mw === "", JSON.stringify(diagram));
  check("Lookout's own chrome is unwrapped out of the clone", diagram.chrome === 0, `chrome=${diagram.chrome}`);
  check("no duplicate ids with a diagram in a cell", diagram.dupeIds.length === 0, `dupes=${diagram.dupeIds.join(",")}`);
  await closeFs();

  /* ====== note-g: a very wide table keeps a readable footnote measure ======= */
  await openFsSettled("#note-g .lookout-table-btn");
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

  /* ============ (ii) note-h: the 4-space dedent, observably ================= */
  await openFsSettled("#note-h .lookout-table-btn");
  const dedent = await page.evaluate(() => {
    const notes = document.querySelector(".lookout-fs-footnotes");
    const fenced = notes.querySelector("code.language-mermaid");
    const plain = Array.from(notes.querySelectorAll("pre code")).filter((c) => !c.className);
    return {
      state: document.querySelector(".lookout-fs").getAttribute("data-lookout-fn"),
      hasFence: !!fenced,
      code: fenced?.textContent || "",
      plainBlocks: plain.length,
      prose: (notes.querySelector("li > p")?.textContent || "").trim(),
      dupeIds: window.__dupeIds(),
    };
  });
  check(
    "a fenced mermaid block inside a definition stays a fence, not indented code",
    dedent.state === "ready" && dedent.hasFence && dedent.plainBlocks === 0,
    JSON.stringify({ state: dedent.state, hasFence: dedent.hasFence, plainBlocks: dedent.plainBlocks })
  );
  check(
    "dedent removes exactly one indent unit, preserving relative indentation",
    dedent.code.startsWith("graph LR") && dedent.code.includes("\n  A[빌드] --> B[검증]"),
    JSON.stringify(dedent.code)
  );
  check("the definition's prose survives alongside the fence", dedent.prose === "배포는 아래 순서로 진행한다.", dedent.prose);
  check("no duplicate ids with a fenced block in a definition", dedent.dupeIds.length === 0, `dupes=${dedent.dupeIds.join(",")}`);
  await closeFs();

  /* ====== (v) note-i: the same footnote referenced twice in one table ======= */
  await openFsSettled("#note-i .lookout-table-btn");
  const dup = await page.evaluate(() => {
    const backs = Array.from(document.querySelectorAll(".lookout-fs-footnotes a.footnote-backref"));
    return {
      state: document.querySelector(".lookout-fs").getAttribute("data-lookout-fn"),
      defs: document.querySelectorAll(".lookout-fs-footnotes li").length,
      value: document.querySelector(".lookout-fs-footnotes li")?.value,
      backs: backs.length,
      hrefs: backs.map((a) => a.getAttribute("href")),
      anyInert: backs.some((a) => a.classList.contains("lookout-fn-unresolved")),
      // (xiii) every surviving footnote id in the overlay is overlay-local.
      strayIds: Array.from(document.querySelectorAll(".lookout-fs [id]"))
        .filter((n) => n.namespaceURI !== "http://www.w3.org/2000/svg")
        .map((n) => n.id)
        .filter((id) => !id.startsWith("lookout-fs-")),
      dupeIds: window.__dupeIds(),
    };
  });
  check("a footnote referenced twice is listed once", dup.state === "ready" && dup.defs === 1 && dup.value === 3, JSON.stringify(dup));
  check(
    "each in-table occurrence gets its own live back-ref",
    dup.backs === 2 && !dup.anyInert && dup.hrefs[0] !== dup.hrefs[1] && dup.hrefs.every((h) => h.startsWith("#lookout-fs-")),
    JSON.stringify(dup.hrefs)
  );
  check("no note-scoped footnote id survives in the overlay", dup.strayIds.length === 0, `stray=${dup.strayIds.join(",")}`);
  check("no duplicate ids with a repeated reference", dup.dupeIds.length === 0, `dupes=${dup.dupeIds.join(",")}`);

  await page.locator(".lookout-fs-footnotes a.footnote-backref").nth(0).click();
  const firstBack = await page.evaluate(() => document.querySelector(".is-lookout-target")?.id);
  await page.locator(".lookout-fs-footnotes a.footnote-backref").nth(1).click();
  const secondBack = await page.evaluate(() => document.querySelector(".is-lookout-target")?.id);
  check("the two back-refs land on different markers", !!firstBack && !!secondBack && firstBack !== secondBack, `${firstBack} vs ${secondBack}`);
  await closeFs();

  /* ===== (iv)/(xi) note-j: an inline footnote with a regex-hostile id ======= */
  await openFsSettled("#note-j .lookout-table-btn");
  const inlineFn = await page.evaluate(() => ({
    state: document.querySelector(".lookout-fs").getAttribute("data-lookout-fn"),
    defs: document.querySelectorAll(".lookout-fs-footnotes li").length,
    text: (document.querySelector(".lookout-fs-footnotes li")?.textContent || "").replace("↩︎", "").trim(),
    value: document.querySelector(".lookout-fs-footnotes li")?.value,
    dupeIds: window.__dupeIds(),
  }));
  check(
    "an inline footnote renders verbatim (nothing stripped) under a `[inline5` label",
    inlineFn.state === "ready" && inlineFn.defs === 1 && inlineFn.text === "넓은 표에 붙은 짧은 각주 한 문장." && inlineFn.value === 6,
    JSON.stringify(inlineFn)
  );
  check("no duplicate ids with an inline footnote", inlineFn.dupeIds.length === 0, `dupes=${inlineFn.dupeIds.join(",")}`);
  await closeFs();

  /* ======== (iv-LP) note-lp: the Live Preview table widget shape ============ */
  // Live Preview parses each block on its own, so the widget's inline marker is
  // `[inline0` while the metadata cache — which parses the whole file — calls
  // that same footnote `[inline1`. Joining the two would render the PARAGRAPH's
  // footnote under the TABLE's marker: wrong text under a right marker, the one
  // outcome the design forbids outright. The marker must go inert instead.
  await openFsSettled("#note-lp .lookout-table-btn");
  const lp = await page.evaluate(() => {
    const a = document.querySelector(".lookout-table-fs-table a.footnote-link");
    return {
      state: document.querySelector(".lookout-fs").getAttribute("data-lookout-fn"),
      sections: document.querySelectorAll(".lookout-fs-footnotes").length,
      inert:
        !a.hasAttribute("href") &&
        a.getAttribute("aria-disabled") === "true" &&
        a.classList.contains("lookout-fn-unresolved"),
      overlayText: document.querySelector(".lookout-fs").textContent,
      dupeIds: window.__dupeIds(),
    };
  });
  check(
    "a Live Preview inline marker is refused, not joined to a block-local index",
    lp.state === "none" && lp.sections === 0 && lp.inert,
    JSON.stringify({ state: lp.state, sections: lp.sections, inert: lp.inert })
  );
  check(
    "no other footnote's text is ever shown under the Live Preview marker",
    !lp.overlayText.includes("문단에 붙은 각주") && !lp.overlayText.includes("표본 정리 전 기준"),
    lp.overlayText.slice(0, 120)
  );
  check("no duplicate ids from the Live Preview shape", lp.dupeIds.length === 0, `dupes=${lp.dupeIds.join(",")}`);
  await closeFs();

  /* ============ (ix) note-m / note-n: embeds resolve to the EMBED =========== */
  await page.evaluate(() => { window.__renderCalls.length = 0; });
  await openFsSettled("#note-m .lookout-table-btn");
  const embed = await page.evaluate(() => ({
    state: document.querySelector(".lookout-fs").getAttribute("data-lookout-fn"),
    text: (document.querySelector(".lookout-fs-footnotes li")?.textContent || "").replace("↩︎", "").trim(),
    sourcePaths: window.__renderCalls.map((c) => c.sourcePath),
    resolutions: window.__linkResolutions.slice(-1),
    dupeIds: window.__dupeIds(),
  }));
  check(
    "an embedded table's footnote comes from the EMBEDDED file, never the host",
    embed.state === "ready" && embed.text === "임베드된 노트의 각주 본문.",
    JSON.stringify(embed)
  );
  check("the renderer is given the embedded file's sourcePath", JSON.stringify(embed.sourcePaths) === '["embedded.md"]', JSON.stringify(embed.sourcePaths));
  check("the embed link is resolved against the host note", embed.resolutions[0]?.linkpath === "embedded" && embed.resolutions[0]?.sourcePath === "note-m.md", JSON.stringify(embed.resolutions));
  check("no duplicate ids from an embedded table", embed.dupeIds.length === 0, `dupes=${embed.dupeIds.join(",")}`);
  await closeFs();

  // The host note defines the very label this embedded marker carries, so a
  // fallback to the host would put the host's text under it. Asserting the
  // STATE alone cannot see that — the assertion has to be on the text.
  await openFsSettled("#note-n .lookout-table-btn");
  const badEmbed = await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll(".lookout-table-fs-table a.footnote-link"));
    return {
      state: document.querySelector(".lookout-fs").getAttribute("data-lookout-fn"),
      section: document.querySelectorAll(".lookout-fs-footnotes").length,
      allInert: anchors.every((a) => !a.hasAttribute("href") && a.getAttribute("aria-disabled") === "true"),
      hostLeak: document.querySelector(".lookout-fs").textContent.includes("호스트 노트의 각주"),
      dupeIds: window.__dupeIds(),
    };
  });
  check(
    "an embed whose src does not resolve degrades cleanly instead of guessing",
    badEmbed.state === "none" && badEmbed.section === 0 && badEmbed.allInert,
    JSON.stringify(badEmbed)
  );
  check("a broken embed never falls back to the HOST note's footnote text", !badEmbed.hostLeak);
  check("no duplicate ids from an unresolved embed", badEmbed.dupeIds.length === 0, `dupes=${badEmbed.dupeIds.join(",")}`);
  await closeFs();

  // An embed whose src is a bare `#heading`: no linkpath to resolve at all.
  await page.evaluate(() => { window.__linkResolutions.length = 0; });
  await openFsSettled("#note-p .lookout-table-btn");
  const fragEmbed = await page.evaluate(() => ({
    state: document.querySelector(".lookout-fs").getAttribute("data-lookout-fn"),
    section: document.querySelectorAll(".lookout-fs-footnotes").length,
    hostLeak: document.querySelector(".lookout-fs").textContent.includes("호스트 노트의 각주"),
    resolutions: window.__linkResolutions.length,
    dupeIds: window.__dupeIds(),
  }));
  check(
    "an embed with no linkpath resolves to no file, never to the host",
    fragEmbed.state === "none" && fragEmbed.section === 0 && !fragEmbed.hostLeak && fragEmbed.resolutions === 0,
    JSON.stringify(fragEmbed)
  );
  check("no duplicate ids from a fragment-only embed", fragEmbed.dupeIds.length === 0, `dupes=${fragEmbed.dupeIds.join(",")}`);
  await closeFs();

  /* ===== §4(a) note-q: markers carrying no usable join key ================== */
  // Nothing to resolve means no promise is started at all: the overlay settles
  // to "none" synchronously and the note's source is never read.
  await page.evaluate(() => { window.__readCalls.length = 0; });
  await openFs("#note-q .lookout-table-btn");
  const unusable = await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll(".lookout-table-fs-table a.footnote-link"));
    return {
      state: document.querySelector(".lookout-fs").getAttribute("data-lookout-fn"),
      anchors: anchors.length,
      allInert: anchors.every(
        (a) =>
          !a.hasAttribute("href") &&
          a.getAttribute("aria-disabled") === "true" &&
          a.classList.contains("lookout-fn-unresolved")
      ),
      section: document.querySelectorAll(".lookout-fs-footnotes").length,
      reads: window.__readCalls.length,
      leak: document.querySelector(".lookout-fs").textContent.includes("회귀다"),
      dupeIds: window.__dupeIds(),
    };
  });
  check(
    "markers with no usable join key settle to 'none' synchronously, with no read",
    unusable.state === "none" && unusable.reads === 0 && unusable.section === 0,
    JSON.stringify({ state: unusable.state, reads: unusable.reads, section: unusable.section })
  );
  check("all three unusable markers are inert", unusable.anchors === 3 && unusable.allInert, JSON.stringify(unusable));
  check("a marker that cannot be numbered emits no definition at all", !unusable.leak);
  check("no duplicate ids with unusable markers", unusable.dupeIds.length === 0, `dupes=${unusable.dupeIds.join(",")}`);
  await closeFs();

  /* ===== note-r: the number comes from the link text, not the href ========== */
  await openFsSettled("#note-r .lookout-table-btn");
  const oddHref = await page.evaluate(() => {
    const li = document.querySelector(".lookout-fs-footnotes li");
    return {
      state: document.querySelector(".lookout-fs").getAttribute("data-lookout-fn"),
      defs: document.querySelectorAll(".lookout-fs-footnotes li").length,
      value: li?.value,
      text: (li?.textContent || "").replace("↩︎", "").trim(),
      markerHref: document.querySelector(".lookout-table-fs-table a.footnote-link")?.getAttribute("href"),
      dupeIds: window.__dupeIds(),
    };
  });
  check(
    "a marker with a non-`fn-N` href is numbered from its visible text",
    oddHref.state === "ready" &&
      oddHref.defs === 1 &&
      oddHref.value === 7 &&
      oddHref.text === "링크 주소로는 번호를 알 수 없는 각주." &&
      !!oddHref.markerHref?.startsWith("#lookout-fs-"),
    JSON.stringify(oddHref)
  );
  check("no duplicate ids with a non-standard href", oddHref.dupeIds.length === 0, `dupes=${oddHref.dupeIds.join(",")}`);
  await closeFs();

  /* ===== §4(d) note-s: a stale metadata index drops, never guesses ========== */
  await openFsSettled("#note-s .lookout-table-btn");
  const stale = await page.evaluate(() => {
    const inertOf = (n) => {
      const a = document.querySelectorAll(".lookout-table-fs-table a.footnote-link")[n];
      return !a.hasAttribute("href") && a.getAttribute("aria-disabled") === "true";
    };
    const overlay = document.querySelector(".lookout-fs");
    return {
      state: overlay.getAttribute("data-lookout-fn"),
      values: Array.from(document.querySelectorAll(".lookout-fs-footnotes li")).map((li) => li.value),
      texts: Array.from(document.querySelectorAll(".lookout-fs-footnotes li")).map((li) =>
        li.textContent.replace("↩︎", "").trim()
      ),
      staleInert: inertOf(2),
      staleInlineInert: inertOf(3),
      blankInert: inertOf(4),
      // Any fragment of the note's prose that a shifted slice would drag in.
      leak: /어긋난 오프셋|다른 인라인 각주|\[\^/.test(overlay.textContent),
      dupeIds: window.__dupeIds(),
    };
  });
  check(
    "honest definitions still build beside stale ones (padding inside `^[ ]` included)",
    stale.state === "ready" &&
      JSON.stringify(stale.values) === "[1,2]" &&
      stale.texts[0] === "온전히 살아남아야 하는 정의." &&
      stale.texts[1] === "여백을 낀 인라인 각주.",
    JSON.stringify({ state: stale.state, values: stale.values, texts: stale.texts })
  );
  check(
    "a stale offset drops its definition and inerts its marker — inline included",
    stale.staleInert && stale.staleInlineInert && stale.blankInert,
    JSON.stringify(stale)
  );
  check("no note prose is ever rendered as a footnote body", !stale.leak, JSON.stringify(stale.texts));
  check("no duplicate ids with a stale index", stale.dupeIds.length === 0, `dupes=${stale.dupeIds.join(",")}`);
  await closeFs();

  /* ===== note-t: an end offset past EOF swallows the next definition ======== */
  await openFsSettled("#note-t .lookout-table-btn");
  const oob = await page.evaluate(() => ({
    state: document.querySelector(".lookout-fs").getAttribute("data-lookout-fn"),
    section: document.querySelectorAll(".lookout-fs-footnotes").length,
    leak: document.querySelector(".lookout-fs").textContent.includes("뒤따르는 다른 정의"),
    dupeIds: window.__dupeIds(),
  }));
  check(
    "an end offset past EOF is dropped, not clamped into the next definition",
    oob.state === "none" && oob.section === 0 && !oob.leak,
    JSON.stringify(oob)
  );
  check("no duplicate ids with an out-of-range offset", oob.dupeIds.length === 0, `dupes=${oob.dupeIds.join(",")}`);
  await closeFs();

  /* ===== note-u: ids a rendered definition body brings with it ============== */
  await openFsSettled("#note-u .lookout-table-btn");
  const rich = await page.evaluate(() => {
    const li = document.querySelector(".lookout-fs-footnotes li");
    return {
      state: document.querySelector(".lookout-fs").getAttribute("data-lookout-fn"),
      heading: li?.querySelector("h3")?.textContent,
      prose: (li?.querySelector("p")?.textContent || "").replace("↩︎", "").trim(),
      liId: li?.id,
      // Every id the overlay carries must be one WE minted.
      strayIds: Array.from(document.querySelectorAll(".lookout-fs [id]"))
        .filter((n) => n.namespaceURI !== "http://www.w3.org/2000/svg")
        .map((n) => n.id)
        .filter((id) => !id.startsWith("lookout-fs-")),
      dupeIds: window.__dupeIds(),
    };
  });
  check(
    "a definition body with a heading and a block id renders in full",
    rich.state === "ready" && rich.heading === "각주 안 제목" && rich.prose === "본문 문단이다.",
    JSON.stringify(rich)
  );
  check(
    "ids the rendered body brought along are scrubbed, the li's own id is not",
    rich.strayIds.length === 0 && !!rich.liId?.startsWith("lookout-fs-"),
    `stray=${rich.strayIds.join(",")} li=${rich.liId}`
  );
  check("no duplicate ids from a rendered definition body", rich.dupeIds.length === 0, `dupes=${rich.dupeIds.join(",")}`);
  await closeFs();

  /* ========== (xii) note-k: the rendered .footnotes section is a decoy ====== */
  await openFsSettled("#note-k .lookout-table-btn");
  const decoy = await page.evaluate(() => {
    const noteLi = document.querySelector("#note-k > .footnotes li");
    return {
      state: document.querySelector(".lookout-fs").getAttribute("data-lookout-fn"),
      text: (document.querySelector(".lookout-fs-footnotes li")?.textContent || "").replace("↩︎", "").trim(),
      noteText: noteLi.textContent.replace("↩︎", "").trim(),
      noteUntouched: noteLi.id === "fn-1-dk" && noteLi.getAttribute("data-footnote-id") === "fn-1-dk",
      dupeIds: window.__dupeIds(),
    };
  });
  check(
    "the overlay shows the SOURCE text, not the note's rendered definition",
    decoy.state === "ready" && decoy.text === "소스에서 읽어야 하는 진짜 본문." && decoy.noteText === "DOM에서 읽으면 안 되는 옛 본문.",
    JSON.stringify(decoy)
  );
  check("the note's own footnote definition is left untouched", decoy.noteUntouched, JSON.stringify(decoy));
  check("no duplicate ids next to a rendered .footnotes section", decoy.dupeIds.length === 0, `dupes=${decoy.dupeIds.join(",")}`);
  await closeFs();

  /* ===== a link inside a footnote body: navigate AND close full screen ====== */
  // Stand-in for Obsidian's own delegated navigation handler: it must still see
  // the click (we neither preventDefault nor stopPropagation on it).
  await page.evaluate(() => {
    window.__navigated = null;
    document.addEventListener("click", (e) => {
      const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
      if (!a) return;
      e.preventDefault();
      window.__navigated = a.getAttribute("href");
    });
  });
  await openFsSettled("#note-o .lookout-table-btn");
  check("no duplicate ids with a link inside a definition", (await dupes()).length === 0);
  await page.locator(".lookout-fs-footnotes a.internal-link").click();
  await page.waitForSelector(".lookout-fs", { state: "detached" });
  const nav = await page.evaluate(() => ({
    navigated: window.__navigated,
    overlays: document.querySelectorAll(".lookout-fs").length,
  }));
  check(
    "a link inside a footnote reaches Obsidian's handler and closes full screen",
    nav.navigated === "other.md" && nav.overlays === 0,
    JSON.stringify(nav)
  );
  // A footnote marker, by contrast, is ours: the delegated handler must not see it.
  await page.evaluate(() => { window.__navigated = null; });
  await openFsSettled("#note-a .lookout-table-btn >> nth=1");
  await page.locator(".lookout-table-fs-table a.footnote-link").click();
  check(
    "a footnote marker click never reaches the note's own click handling",
    (await page.evaluate(() => window.__navigated)) === null
  );
  await closeFs();

  /* ============ (viii) async ordering: close before the read lands ========== */
  const beforeCounts = await page.evaluate(() => ({
    loaded: window.__componentsLoaded,
    unloaded: window.__componentsUnloaded,
  }));
  await page.evaluate(() => { window.__gateRead = true; });
  await openFs("#note-a .lookout-table-btn >> nth=1");
  check(
    "a footnote overlay advertises 'pending' before its source read lands",
    (await fnState()) === "pending"
  );
  await page.keyboard.press("Escape");
  await page.waitForSelector(".lookout-fs", { state: "detached" });
  await page.evaluate(() => { window.__releaseRead(); });
  await page.waitForTimeout(120);
  const late = await page.evaluate(() => ({
    overlays: document.querySelectorAll(".lookout-fs").length,
    sections: document.querySelectorAll(".lookout-fs-footnotes").length,
    loaded: window.__componentsLoaded,
    unloaded: window.__componentsUnloaded,
  }));
  check(
    "a read landing after Escape appends nothing and leaks no Component",
    late.overlays === 0 && late.sections === 0 && late.loaded - beforeCounts.loaded === late.unloaded - beforeCounts.unloaded,
    JSON.stringify(late)
  );

  await page.evaluate(() => { window.__gateRead = false; });
  await openFsSettled("#note-a .lookout-table-btn >> nth=1");
  const reopened = await page.evaluate(() => {
    const li = document.querySelector(".lookout-fs-footnotes li");
    return {
      state: document.querySelector(".lookout-fs").getAttribute("data-lookout-fn"),
      id: li?.id,
      text: (li?.textContent || "").replace("↩︎", "").trim(),
      dupeIds: window.__dupeIds(),
    };
  });
  check(
    "re-opening immediately rebuilds the section under a FRESH namespace",
    reopened.state === "ready" &&
      reopened.text === "표와 문단 양쪽에서 참조되는 각주." &&
      reopened.id !== reg.liId &&
      reopened.id.startsWith("lookout-fs-"),
    JSON.stringify({ now: reopened.id, before: reg.liId })
  );
  check("no duplicate ids after a re-open", reopened.dupeIds.length === 0, `dupes=${reopened.dupeIds.join(",")}`);
  await closeFs();

  const balance = await page.evaluate(() => ({
    loaded: window.__componentsLoaded,
    unloaded: window.__componentsUnloaded,
  }));
  check("every Component created for an overlay is unloaded with it", balance.loaded === balance.unloaded, JSON.stringify(balance));

  /* ================= focus restoration is keyboard-only ================= */
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

  /* ===== modal semantics + focus trap ===== */
  // The footnoted table on purpose: its overlay holds a close button, a marker
  // and a back-reference, so Tab has somewhere to cycle and wrap-around is
  // actually exercised. A plain table offers only the close button, which would
  // pass the trap check without ever testing it.
  await page.locator(".lookout-table-btn").nth(1).click({ force: true });
  await page.waitForSelector(".lookout-fs-footnotes li");

  const modal = await page.evaluate(() => {
    const fs = document.querySelector(".lookout-fs--table");
    return {
      role: fs.getAttribute("role"),
      ariaModal: fs.getAttribute("aria-modal"),
      ariaLabel: fs.getAttribute("aria-label"),
    };
  });
  check(
    "the full-screen table overlay announces itself as a modal dialog",
    modal.role === "dialog" && modal.ariaModal === "true" && !!modal.ariaLabel,
    JSON.stringify(modal)
  );

  // Tab must cycle inside the overlay. Without the trap the first Tab walks
  // onto the note's own controls behind it — focus lands somewhere the reader
  // cannot see, and the next Enter activates it.
  const trap = { escaped: 0, seen: [] };
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("Tab");
    const where = await page.evaluate(() => {
      const a = document.activeElement;
      return {
        inside: !!a && !!a.closest(".lookout-fs--table"),
        tag: a ? a.tagName + (a.className ? "." + String(a.className).split(" ")[0] : "") : "none",
      };
    });
    if (!where.inside) trap.escaped++;
    trap.seen.push(where.tag);
  }
  check("Tab never escapes the full-screen overlay", trap.escaped === 0, JSON.stringify(trap));
  check(
    "Tab actually cycles — the overlay offers more than one stop",
    new Set(trap.seen).size > 1,
    JSON.stringify(trap.seen)
  );

  const shift = { escaped: 0 };
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press("Shift+Tab");
    const inside = await page.evaluate(
      () => !!document.activeElement && !!document.activeElement.closest(".lookout-fs--table")
    );
    if (!inside) shift.escaped++;
  }
  check("Shift+Tab never escapes the full-screen overlay", shift.escaped === 0, JSON.stringify(shift));

  await page.keyboard.press("Escape");
  await page.waitForSelector(".lookout-fs", { state: "detached" });

  const inPage = await page.evaluate(() => window.__pageErrors);
  check("no page errors", pageErrors.length === 0 && inPage.length === 0, [...pageErrors, ...inPage].join(" | "));
} finally {
  await browser.close();
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll E2E checks passed.");
