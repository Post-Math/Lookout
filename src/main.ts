/*
 * Lookout — survey wide diagrams and tables in Obsidian.
 *
 * Mermaid diagrams: pan (wheel/drag), zoom (Ctrl+wheel/buttons), fit-to-frame,
 * and full screen. Tables: a full-screen button so wide tables can be read
 * without squinting through the note's horizontal scrollbar (no zoom).
 *
 * Authored in TypeScript; esbuild bundles this to main.js (see
 * docs/DEVELOPMENT.md). The visual language is a "drafting / survey instrument":
 * Obsidian theme surfaces with a single survey-cyan accent and a monospace gauge.
 */

import { Notice, Plugin } from "obsidian";

const PAD = 24; // slack (px) so diagram edges can be panned just past the frame
const MIN_SCALE = 0.1;
const MAX_SCALE = 8;
const ZOOM_STEP = 1.2; // per button press
const INLINE_FLOOR = 56; // min inline frame height (px) — just enough for the toolbar
const INLINE_MAX_VH = 0.7; // inline frame caps at 70% of the viewport height

/* ---- lucide-style icons, 1.75px stroke for a precise drafting feel ---- */
type IconChild = [tag: string, attrs: Record<string, string>];

const ICONS = {
  minus: [["line", { x1: "5", y1: "12", x2: "19", y2: "12" }]],
  plus: [
    ["line", { x1: "5", y1: "12", x2: "19", y2: "12" }],
    ["line", { x1: "12", y1: "5", x2: "12", y2: "19" }],
  ],
  // "fit to frame": a frame with a horizontal double-arrow inside.
  fit: [
    ["rect", { x: "3", y: "5", width: "18", height: "14", rx: "2" }],
    ["path", { d: "M7.5 12h9" }],
    ["path", { d: "M10 9.5 7.5 12l2.5 2.5" }],
    ["path", { d: "M14 9.5 16.5 12 14 14.5" }],
  ],
  // "fullscreen": arrows pushing out to the four corners.
  full: [
    ["path", { d: "M8 3H5a2 2 0 0 0-2 2v3" }],
    ["path", { d: "M21 8V5a2 2 0 0 0-2-2h-3" }],
    ["path", { d: "M3 16v3a2 2 0 0 0 2 2h3" }],
    ["path", { d: "M16 21h3a2 2 0 0 0 2-2v-3" }],
  ],
  close: [
    ["line", { x1: "18", y1: "6", x2: "6", y2: "18" }],
    ["line", { x1: "6", y1: "6", x2: "18", y2: "18" }],
  ],
} satisfies Record<string, IconChild[]>;

type IconName = keyof typeof ICONS;

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Build one of the {@link ICONS} glyphs as a sized, theme-coloured `<svg>`
 * element. Constructed via the DOM (no `innerHTML`), per Obsidian's guidelines.
 */
function svgIcon(name: IconName): SVGSVGElement {
  const svg = activeDocument.createElementNS(SVG_NS, "svg");
  const attrs: Record<string, string> = {
    class: "lookout-ico",
    viewBox: "0 0 24 24",
    width: "16",
    height: "16",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.75",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  };
  for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v);
  for (const [tag, childAttrs] of ICONS[name]) {
    const child = activeDocument.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(childAttrs)) child.setAttribute(k, v);
    svg.appendChild(child);
  }
  return svg;
}

/** Create an element with an optional class. Tag-typed so callers keep `.type`, `.disabled`, … */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string
): HTMLElementTagNameMap[K] {
  const node = activeDocument.createElement(tag);
  if (cls) node.className = cls;
  return node;
}

/** Clamp `v` into the inclusive `[lo, hi]` range. */
const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v));

const REDUCED_MOTION =
  typeof window !== "undefined" &&
  !!window.matchMedia &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

type ViewMode = "actual" | "fit" | "free";

interface DragState {
  id: number;
  sx: number;
  sy: number;
  tx: number;
  ty: number;
}

interface DiagramViewOptions {
  /** true for the full-screen clone, false/absent for the inline frame */
  fullscreen?: boolean;
  /** called when a full-screen view closes */
  onClose?: (() => void) | null;
  /** inline: the svg's original parent element */
  parent?: HTMLElement | null;
  /** inline: node to insert the viewport before */
  anchor?: Node | null;
}

/**
 * One pan/zoom controller around a single Mermaid <svg>.
 * Used both inline (wraps the rendered svg in place) and in full-screen
 * (wraps a clone inside a fixed overlay).
 */
class DiagramView {
  svg: SVGSVGElement;
  fs: boolean;
  onClose: (() => void) | null;
  parent: HTMLElement | null;
  anchor: Node | null;
  host: Element | null;

  scale: number;
  tx: number;
  ty: number;
  minScale: number;
  maxScale: number;
  viewMode: ViewMode;
  lastWidth: number;

  drag: DragState | null;
  destroyed: boolean;

  nat!: { w: number; h: number };
  stage!: HTMLDivElement;
  viewport!: HTMLDivElement;
  overlay?: HTMLDivElement;
  toolbar!: HTMLDivElement;
  btnOut!: HTMLButtonElement;
  btnIn!: HTMLButtonElement;
  btnFit!: HTMLButtonElement;
  gauge!: HTMLButtonElement;
  gaugeNum!: HTMLSpanElement;
  gaugeTrack!: HTMLSpanElement;
  gaugeFill!: HTMLSpanElement;
  ro?: ResizeObserver;
  _animTimer?: number;
  _fsView: DiagramView | null = null;

  constructor(svg: SVGSVGElement, options: DiagramViewOptions = {}) {
    this.svg = svg;
    this.fs = !!options.fullscreen;
    this.onClose = options.onClose || null;
    this.parent = options.parent || null; // inline: original parent of the svg
    this.anchor = options.anchor || null; // inline: node to insert the viewport before
    this.host = null; // inline: the .mermaid wrapper we neutralize

    this.scale = 1;
    this.tx = 0;
    this.ty = 0;
    this.minScale = MIN_SCALE;
    this.maxScale = MAX_SCALE;
    // View modes: "actual" = 1:1 top-left (default), "fit" = scaled to frame,
    // "free" = user has panned/zoomed manually. Drives behaviour on resize.
    this.viewMode = "actual";
    this.lastWidth = 0;

    this.drag = null;
    this.destroyed = false;

    this._build();
  }

  /* ---------- natural (intrinsic) size of the diagram ---------- */
  _measure() {
    let w = 0;
    let h = 0;
    const vb = this.svg.viewBox && this.svg.viewBox.baseVal;
    if (vb && vb.width) {
      w = vb.width;
      h = vb.height;
    }
    if (!w) {
      const r = this.svg.getBoundingClientRect();
      w = r.width;
      h = r.height;
    }
    if (!w) {
      try {
        const b = this.svg.getBBox();
        w = b.width;
        h = b.height;
      } catch {
        /* svg not laid out yet */
      }
    }
    this.nat = { w: w || 320, h: h || 180 };
  }

  _build() {
    this._measure();

    // The svg renders at its intrinsic size; the stage transform does the rest.
    this.svg.setCssStyles({
      width: this.nat.w + "px",
      height: this.nat.h + "px",
      maxWidth: "none",
      display: "block",
    });

    this.stage = el("div", "lookout-stage");
    this.viewport = el(
      "div",
      "lookout-viewport" + (this.fs ? " lookout-viewport--fs" : "")
    );
    this.viewport.tabIndex = 0;
    this.viewport.setAttribute("role", "group");
    this.viewport.setAttribute(
      "aria-label",
      "Mermaid 다이어그램 — 드래그/스크롤로 이동, Ctrl+스크롤로 확대"
    );

    this.stage.appendChild(this.svg);
    this.viewport.appendChild(this.stage);

    if (this.fs) {
      this.overlay = el("div", "lookout-fs");
      this.overlay.appendChild(this.viewport);
      activeDocument.body.appendChild(this.overlay);
    } else {
      // svg has been moved into the stage; place the viewport where it used to be.
      // The clamp/center styles live on Obsidian's `.mermaid` wrapper, which is
      // usually the svg's direct parent but can be an ancestor (the svg may be
      // nested, or caught only by its `mermaid-*` id). Stamp whichever element
      // actually carries `.mermaid` so `.mermaid.lookout-host` always matches;
      // fall back to the parent when there is no `.mermaid` (nothing to clamp).
      const parent = this.parent!;
      this.host = parent.closest(".mermaid") || parent;
      this.host.classList.add("lookout-host");
      parent.insertBefore(this.viewport, this.anchor);
    }

    this._buildToolbar();
    this._attach();

    // Apply the initial view once the viewport has a real width.
    this._scheduleInitialView();
  }

  _buildToolbar() {
    const bar = el(
      "div",
      "lookout-toolbar" + (this.fs ? " lookout-toolbar--fs" : "")
    );
    bar.setAttribute("role", "toolbar");

    const mkBtn = (
      icon: IconName,
      label: string,
      handler: () => void,
      extraCls?: string
    ): HTMLButtonElement => {
      const b = el("button", "lookout-btn" + (extraCls ? " " + extraCls : ""));
      b.type = "button";
      b.appendChild(svgIcon(icon));
      b.setAttribute("aria-label", label);
      b.title = label;
      b.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        handler();
      });
      return b;
    };

    const divider = () => el("span", "lookout-divider");

    this.btnOut = mkBtn("minus", "축소", () => this.zoomBy(1 / ZOOM_STEP));
    this.btnIn = mkBtn("plus", "확대", () => this.zoomBy(ZOOM_STEP));

    // Signature element: the survey gauge (monospace readout + proportional tick).
    this.gauge = el("button", "lookout-gauge");
    this.gauge.type = "button";
    this.gauge.setAttribute("aria-label", "실제 크기(100%) · 좌상단 정렬로 보기");
    this.gauge.title = "100% (좌상단)";
    this.gaugeNum = el("span", "lookout-gauge-num");
    this.gaugeNum.textContent = "100%";
    this.gaugeTrack = el("span", "lookout-gauge-track");
    this.gaugeFill = el("span", "lookout-gauge-fill");
    this.gaugeTrack.appendChild(this.gaugeFill);
    this.gauge.appendChild(this.gaugeNum);
    this.gauge.appendChild(this.gaugeTrack);
    this.gauge.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.actualSize(true);
    });

    this.btnFit = mkBtn("fit", "프레임에 맞추기", () => this.fit(true));

    bar.appendChild(this.btnOut);
    bar.appendChild(this.gauge);
    bar.appendChild(this.btnIn);
    bar.appendChild(divider());
    bar.appendChild(this.btnFit);

    if (this.fs) {
      const btnClose = mkBtn("close", "닫기", () => this.close(), "lookout-btn--close");
      bar.appendChild(divider());
      bar.appendChild(btnClose);
    } else {
      const btnFull = mkBtn("full", "전체 화면으로 보기", () => this.openFullscreen());
      bar.appendChild(btnFull);
    }

    this.toolbar = bar;
    this.viewport.appendChild(bar);
  }

  _attach() {
    this.viewport.addEventListener("wheel", this.onWheel, { passive: false });
    this.viewport.addEventListener("pointerdown", this.onPointerDown);
    this.viewport.addEventListener("keydown", this.onKeyDown);

    if (typeof ResizeObserver !== "undefined") {
      this.ro = new ResizeObserver(this.onResize);
      this.ro.observe(this.viewport);
    }
    if (this.fs) {
      activeDocument.addEventListener("keydown", this.onKeyDown, true);
    }
  }

  _scheduleInitialView(tries = 0) {
    window.requestAnimationFrame(() => {
      if (this.destroyed) return;
      if (this.viewport.clientWidth > 0) {
        // Inline default is 1:1 top-left; full screen opens fit-to-frame.
        if (this.fs) this.fit(false);
        else this.actualSize(false);
      } else if (tries < 30) {
        this._scheduleInitialView(tries + 1);
      }
    });
  }

  /* ---------- layout ---------- */
  // Frame height tracks the *displayed* diagram height (natural height × the
  // current scale), rounded UP so the frame is never a sub-pixel shorter than
  // the diagram — which would surface as a slight vertical scroll. At 100%
  // (scale = 1) this is the natural height, capped at 70vh (taller diagrams
  // then pan); in "fit" the scale is contained so the whole diagram sits inside
  // the frame with the heights matching exactly. INLINE_FLOOR keeps the toolbar
  // usable — a diagram shorter than it simply sits smaller (acceptable).
  _setInlineHeight(scale = 1) {
    if (this.fs) return;
    const target = Math.ceil(
      clamp(this.nat.h * scale, INLINE_FLOOR, this._inlineMaxHeight())
    );
    this.viewport.setCssStyles({ height: target + "px" });
    // Obsidian applies `box-sizing: border-box` app-wide, so the viewport's 1px
    // border eats into the content box: clientHeight comes back short and the
    // diagram (sized against `target`) overflows by a pixel or two. Add the
    // shortfall back so the *content* box is exactly `target`, regardless of the
    // inherited box-sizing.
    const shortfall = target - this.viewport.clientHeight;
    if (shortfall > 0) {
      this.viewport.setCssStyles({ height: target + shortfall + "px" });
    }
  }

  // The inline frame's height ceiling (70vh) — a fixed fraction of the window,
  // not the live viewport height, so `fit` can contain a tall diagram against
  // it without the chicken-and-egg of resizing the frame it is measuring.
  _inlineMaxHeight() {
    return Math.round(window.innerHeight * INLINE_MAX_VH);
  }

  // Default / "100%" view: actual size, anchored top-left.
  actualSize(animate: boolean) {
    this._setInlineHeight();
    const vw = this.viewport.clientWidth;
    if (!vw) return;
    this.scale = 1;
    this.tx = 0;
    this.ty = 0;
    this._clampPan();
    this.viewMode = "actual";
    this.lastWidth = vw;
    this._render(animate);
  }

  // "Fit to frame": scale so the whole diagram fits, centered. Inline, contain
  // the diagram inside the frame width AND the 70vh height cap, then size the
  // frame to that fitted height so the frame and the content match exactly —
  // no vertical scroll, even for a tall (e.g. sequenceDiagram) shape. Full
  // screen contains the diagram inside the overlay.
  fit(animate: boolean) {
    const vw = this.viewport.clientWidth;
    if (!vw) return;

    let s: number;
    if (this.fs) {
      const vh = this.viewport.clientHeight;
      if (!vh) return;
      // contain inside the overlay, never upscale past 1:1
      s = Math.min(vw / this.nat.w, vh / this.nat.h);
    } else {
      // contain inside the frame width and the 70vh height cap — the height
      // term is what keeps a tall diagram from overflowing the frame.
      s = Math.min(vw / this.nat.w, this._inlineMaxHeight() / this.nat.h);
    }
    s = clamp(Math.min(s, 1), this.minScale, this.maxScale);
    this.scale = s;
    // Inline: size the frame to the fitted height (before centering, which
    // reads the new height) so frame and content heights match.
    if (!this.fs) this._setInlineHeight(s);
    this._center();
    this.viewMode = "fit";
    this.lastWidth = vw;
    this._render(animate);
  }

  _center() {
    const vw = this.viewport.clientWidth;
    const vh = this.viewport.clientHeight;
    const cw = this.nat.w * this.scale;
    const ch = this.nat.h * this.scale;
    this.tx = cw <= vw ? (vw - cw) / 2 : PAD;
    this.ty = ch <= vh ? (vh - ch) / 2 : PAD;
    this._clampPan();
  }

  _panBounds() {
    const vw = this.viewport.clientWidth;
    const vh = this.viewport.clientHeight;
    const cw = this.nat.w * this.scale;
    const ch = this.nat.h * this.scale;
    let txMin: number, txMax: number, tyMin: number, tyMax: number;
    if (cw <= vw) {
      txMin = txMax = (vw - cw) / 2;
    } else {
      txMax = PAD;
      txMin = vw - cw - PAD;
    }
    if (ch <= vh) {
      tyMin = tyMax = (vh - ch) / 2;
    } else {
      tyMax = PAD;
      tyMin = vh - ch - PAD;
    }
    return { txMin, txMax, tyMin, tyMax };
  }

  _clampPan() {
    const b = this._panBounds();
    this.tx = clamp(this.tx, b.txMin, b.txMax);
    this.ty = clamp(this.ty, b.tyMin, b.tyMax);
  }

  /* ---------- zoom ---------- */
  zoomTo(newScale: number, cx: number, cy: number, animate: boolean) {
    newScale = clamp(newScale, this.minScale, this.maxScale);
    const k = newScale / this.scale;
    this.tx = cx - (cx - this.tx) * k;
    this.ty = cy - (cy - this.ty) * k;
    this.scale = newScale;
    this._clampPan();
    this._render(animate);
  }

  zoomBy(factor: number) {
    this.viewMode = "free";
    this.zoomTo(
      this.scale * factor,
      this.viewport.clientWidth / 2,
      this.viewport.clientHeight / 2,
      true
    );
  }

  /* ---------- input handlers ---------- */
  onWheel = (e: WheelEvent) => {
    const rect = this.viewport.getBoundingClientRect();

    if (e.ctrlKey || e.metaKey) {
      // Ctrl/Cmd + wheel → zoom toward the cursor.
      e.preventDefault();
      this.viewMode = "free";
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const f = Math.pow(1.0017, -e.deltaY);
      this.zoomTo(this.scale * f, cx, cy, false);
      return;
    }

    // Plain wheel → pan. Shift maps vertical wheel to horizontal.
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? rect.height : 1;
    let mx = e.deltaX * unit;
    let my = e.deltaY * unit;
    if (e.shiftKey && mx === 0) {
      mx = my;
      my = 0;
    }

    const before = { tx: this.tx, ty: this.ty };
    this.tx -= mx;
    this.ty -= my;
    this._clampPan();

    const verticalDominant = Math.abs(my) >= Math.abs(mx);
    const movedDominant = verticalDominant
      ? this.ty !== before.ty
      : this.tx !== before.tx;

    if (movedDominant) {
      e.preventDefault();
      this.viewMode = "free";
      this._render(false);
    } else {
      // At the edge with no room on the dominant axis → release to page scroll.
      this.tx = before.tx;
      this.ty = before.ty;
    }
  }

  onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const target = e.target as Element | null;
    if (target && target.closest(".lookout-toolbar")) return;
    this.drag = {
      id: e.pointerId,
      sx: e.clientX,
      sy: e.clientY,
      tx: this.tx,
      ty: this.ty,
    };
    this.viewport.classList.add("is-dragging");
    try {
      this.viewport.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    this.viewport.addEventListener("pointermove", this.onPointerMove);
    this.viewport.addEventListener("pointerup", this.onPointerUp);
    this.viewport.addEventListener("pointercancel", this.onPointerUp);
  }

  onPointerMove = (e: PointerEvent) => {
    if (!this.drag || e.pointerId !== this.drag.id) return;
    this.viewMode = "free";
    this.tx = this.drag.tx + (e.clientX - this.drag.sx);
    this.ty = this.drag.ty + (e.clientY - this.drag.sy);
    this._clampPan();
    this._render(false);
  }

  onPointerUp = (e: PointerEvent) => {
    if (!this.drag) return;
    this.viewport.classList.remove("is-dragging");
    try {
      this.viewport.releasePointerCapture(this.drag.id);
    } catch {
      /* ignore */
    }
    this.viewport.removeEventListener("pointermove", this.onPointerMove);
    this.viewport.removeEventListener("pointerup", this.onPointerUp);
    this.viewport.removeEventListener("pointercancel", this.onPointerUp);
    this.drag = null;
  }

  onKeyDown = (e: KeyboardEvent) => {
    // Full-screen Esc is captured at document level.
    if (this.fs && e.key === "Escape") {
      e.preventDefault();
      this.close();
      return;
    }
    if (!this.fs && activeDocument.activeElement !== this.viewport) return;

    const step = 60;
    switch (e.key) {
      case "+":
      case "=":
        e.preventDefault();
        this.zoomBy(ZOOM_STEP);
        break;
      case "-":
      case "_":
        e.preventDefault();
        this.zoomBy(1 / ZOOM_STEP);
        break;
      case "0":
        e.preventDefault();
        this.actualSize(true); // reset to 100% top-left
        break;
      case "ArrowUp":
        e.preventDefault();
        this._nudge(0, step);
        break;
      case "ArrowDown":
        e.preventDefault();
        this._nudge(0, -step);
        break;
      case "ArrowLeft":
        e.preventDefault();
        this._nudge(step, 0);
        break;
      case "ArrowRight":
        e.preventDefault();
        this._nudge(-step, 0);
        break;
      case "f":
      case "F":
        if (!this.fs) {
          e.preventDefault();
          this.openFullscreen();
        }
        break;
      default:
        return;
    }
  }

  _nudge(dx: number, dy: number) {
    this.viewMode = "free";
    this.tx += dx;
    this.ty += dy;
    this._clampPan();
    this._render(true);
  }

  onResize = () => {
    if (this.destroyed) return;
    const vw = this.viewport.clientWidth;
    if (!vw) return;
    if (vw !== this.lastWidth) {
      this.lastWidth = vw;
      if (this.viewMode === "fit") {
        this.fit(false);
      } else if (this.viewMode === "actual") {
        this.actualSize(false);
      } else {
        this._clampPan();
        this._render(false);
      }
    }
  }

  /* ---------- render ---------- */
  _render(animate: boolean) {
    if (animate && !REDUCED_MOTION) {
      this.stage.classList.add("is-animating");
      window.clearTimeout(this._animTimer);
      this._animTimer = window.setTimeout(() => {
        this.stage.classList.remove("is-animating");
      }, 190);
    }
    this.stage.setCssStyles({
      transform:
        "translate(" + this.tx + "px," + this.ty + "px) scale(" + this.scale + ")",
    });

    const pct = Math.round(this.scale * 100);
    this.gaugeNum.textContent = pct + "%";

    // Gauge tick fills logarithmically across the zoom range (1:1 sits mid-track).
    const ls = Math.log(this.scale);
    const lmin = Math.log(this.minScale);
    const lmax = Math.log(this.maxScale);
    const frac = clamp((ls - lmin) / (lmax - lmin), 0, 1);
    this.gaugeFill.setCssStyles({ width: (frac * 100).toFixed(1) + "%" });

    this.btnOut.disabled = this.scale <= this.minScale + 1e-4;
    this.btnIn.disabled = this.scale >= this.maxScale - 1e-4;
  }

  /* ---------- full-screen ---------- */
  openFullscreen() {
    if (this._fsView) return;
    const clone = this.svg.cloneNode(true) as SVGSVGElement;
    clone.setCssStyles({ width: "", height: "", maxWidth: "" });
    this._fsView = new DiagramView(clone, {
      fullscreen: true,
      onClose: () => {
        this._fsView = null;
        this.viewport.focus({ preventScroll: true });
      },
    });
  }

  close() {
    if (!this.fs) return;
    this.destroy();
    if (this.onClose) this.onClose();
  }

  /* ---------- teardown ---------- */
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    window.clearTimeout(this._animTimer);
    if (this.ro) this.ro.disconnect();
    if (this.fs) {
      activeDocument.removeEventListener("keydown", this.onKeyDown, true);
      if (this.overlay) this.overlay.remove();
      return;
    }
    // Restore the inline svg to its original parent so unloading is clean.
    this.svg.setCssStyles({ width: "", height: "", maxWidth: "", display: "" });
    if (this.parent && this.viewport.parentElement === this.parent) {
      this.parent.insertBefore(this.svg, this.viewport);
      this.viewport.remove();
      if (this.host) this.host.classList.remove("lookout-host");
    }
  }
}

interface TableViewOptions {
  /** the table's original parent element */
  parent: HTMLElement;
  /** node to insert the host before */
  anchor: Node | null;
}

/**
 * Obsidian's Live Preview table editor injects interactive controls *inside*
 * the rendered table, on both axes: the column/row menu buttons
 * (`.table-col-btn`, `.table-row-btn`) and the drag grips
 * (`.table-col-drag-handle` — a horizontal ":::" grip, `.table-row-drag-handle`
 * — a vertical "⋮" grip). They are useful while editing but are dead chrome in
 * our read-only full-screen clone, so we strip all four from the clone (never
 * the live table).
 */
const TABLE_EDITOR_CHROME =
  ".table-col-btn, .table-row-btn, .table-col-drag-handle, .table-row-drag-handle";

/*
 * Footnotes in the full-screen table clone.
 *
 * The clone lives outside the note's rendered container, so everything the
 * footnote mechanism relies on beyond the <table> subtree — the note's
 * `.footnotes` definition list, Obsidian's own scoped click handlers, the
 * `#fn-…`/`#fnref-…` id anchors — is unreachable from the overlay. We therefore
 * clone the *definitions* in next to the table and re-point every footnote id
 * and `#`-href at overlay-local copies. Everything below feeds that.
 */

/** A footnote reference marker inside a cell — never the definition's back-ref. */
const FN_REF = 'a.footnote-link:not(.footnote-backref)[href^="#"]';
/** Every footnote anchor in the overlay (refs *and* back-refs) needs re-pointing. */
const FN_ANCHOR = 'a.footnote-link[href^="#"]';
/**
 * The note's rendered definitions. Reading view only: in Live Preview the table
 * widget renders its slice in isolation and no definition list exists anywhere
 * in the DOM, so this legitimately finds nothing (see the degradation path in
 * `_buildFootnotes`).
 */
const FN_DEF = ".footnotes li";
/**
 * Nodes carrying a footnote identity that must be re-namespaced on the clone.
 * Deliberately narrow — a blanket id rewrite would also hit `url(#…)` /
 * `clip-path` targets inside any SVG a cell happens to contain.
 *
 * Obsidian itself stamps `data-footnote-id` on the `<sup class="footnote-ref">`
 * and on the definition `<li>` — never on the anchors, which carry only the
 * `#fn-…`/`#fnref-…` href. Anchors are nevertheless excluded here: should a
 * renderer stamp one, the marker and its containing `<sup>` would mint the same
 * id twice (invalid DOM) and, since the jump map is built in document order,
 * the map would point at the nested "↩︎" glyph instead of the definition.
 * Anchors are re-pointed by the FN_ANCHOR pass below instead.
 */
const FN_IDENTIFIED =
  "[data-footnote-id]:not(a), .footnotes li[id], sup.footnote-ref[id]";
/**
 * Lookout's own chrome, for the case where a cloned footnote definition happens
 * to contain an already-processed table or diagram. Buttons/toolbars in a clone
 * are dead (their listeners belong to the live view), so they are removed; the
 * wrappers are unwrapped so the content inside them survives as plain markup.
 */
const LOOKOUT_CHROME = ".lookout-btn, .lookout-toolbar";
const LOOKOUT_WRAPPERS =
  ".lookout-table-host, .lookout-table-scroll, .lookout-viewport, .lookout-stage";
/**
 * Nearest note-ish root to read definitions from — never `activeDocument`. A
 * second pane on the same note renders its own copy with a different `docId`,
 * so a document-wide search could silently pick up the *other* pane's list.
 */
const NOTE_ROOT =
  ".markdown-embed, .markdown-preview-view, .markdown-rendered, .markdown-source-view";

/**
 * Monotonic across every overlay ever opened, so the ids minted for one
 * full-screen view can never collide with another's (two overlays at once, or a
 * re-open of the same table).
 */
let fsSeq = 0;

/**
 * Wide tables get a single full-screen button (no zoom). Inline, the table
 * keeps its normal horizontal scroll inside our own scroll wrapper so the
 * button can stay pinned to the visible top-right corner. Full screen shows
 * the table in a maximized scroll area where its full width fits far better
 * than in the note's narrow reading column.
 */
class TableView {
  table: HTMLTableElement;
  parent: HTMLElement;
  anchor: Node | null;
  destroyed: boolean;
  host!: HTMLDivElement;
  scroll!: HTMLDivElement;
  overlay: HTMLDivElement | null = null;
  /** the inline trigger, kept so focus can return to it when the overlay closes */
  fsBtn!: HTMLButtonElement;
  /** namespaced footnote id → the node in the overlay it now identifies */
  fsTargets: Map<string, HTMLElement> | null = null;
  fsHighlightTimer: number | null = null;

  constructor(table: HTMLTableElement, options: TableViewOptions) {
    this.table = table;
    this.parent = options.parent;
    this.anchor = options.anchor;
    this.destroyed = false;
    this._build();
  }

  _build() {
    this.host = el("div", "lookout-table-host");
    this.scroll = el("div", "lookout-table-scroll");

    this.parent.insertBefore(this.host, this.anchor);
    this.scroll.appendChild(this.table);
    this.host.appendChild(this.scroll);

    const btn = el("button", "lookout-btn lookout-table-btn");
    btn.type = "button";
    btn.appendChild(svgIcon("full"));
    btn.setAttribute("aria-label", "표를 전체 화면으로 보기");
    btn.title = "전체 화면으로 보기";
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.openFullscreen();
    });
    this.host.appendChild(btn);
    this.fsBtn = btn;
  }

  /*
   * The note container this table belongs to. Scoped on purpose: reading the
   * definitions from `activeDocument` would let a second pane showing the same
   * note donate its (differently-id'd, non-matching) list.
   */
  _noteRoot(): HTMLElement | null {
    return (
      this.table.closest<HTMLElement>(NOTE_ROOT) ??
      this.table.closest<HTMLElement>(".workspace-leaf")
    );
  }

  /*
   * Index the note's rendered footnote definitions by the id its references
   * point at. Strictly read-only over live, Obsidian-owned DOM: nothing here
   * moves, re-ids or otherwise touches the note.
   */
  _collectDefs(): Map<string, HTMLElement> {
    const map = new Map<string, HTMLElement>();
    const root = this._noteRoot();
    if (!root) return map;
    root.querySelectorAll(FN_DEF).forEach((li) => {
      if (!li.instanceOf(HTMLElement)) return;
      const key = li.id || li.getAttribute("data-footnote-id") || "";
      if (!key || map.has(key)) return;
      map.set(key, li);
    });
    return map;
  }

  /*
   * Clone hygiene: strip the Live Preview editor chrome and any of Lookout's
   * own controls that rode along, then unwrap Lookout's wrappers so their
   * contents survive as plain rendered markup. Idempotent, and safe to run on
   * anything — outer wrappers are unwrapped before inner ones (the NodeList is
   * static and in document order) and children move into the still-attached
   * grandparent, so nothing is orphaned.
   *
   * It also drops every `id` the clone carried over, except on the footnote
   * identity nodes `_namespace` is about to re-mint. A table can legitimately
   * own one (Obsidian stamps a `^block-id` onto the element) and a cell can
   * contain anything, so without this the overlay would put a second copy of
   * those ids in the document for as long as it is open — invalid DOM, and
   * enough to send an in-note `#…` link to the clone instead of the note.
   */
  _scrub(root: HTMLElement) {
    root.querySelectorAll(TABLE_EDITOR_CHROME).forEach((node) => node.remove());
    root.querySelectorAll(LOOKOUT_CHROME).forEach((node) => node.remove());
    root.querySelectorAll(LOOKOUT_WRAPPERS).forEach((wrap) => {
      const parent = wrap.parentElement;
      if (!parent) return;
      while (wrap.firstChild) parent.insertBefore(wrap.firstChild, wrap);
      wrap.remove();
    });
    if (root.id && !root.matches(FN_IDENTIFIED)) root.removeAttribute("id");
    root.querySelectorAll("[id]").forEach((node) => {
      if (!node.matches(FN_IDENTIFIED)) node.removeAttribute("id");
    });
  }

  /*
   * Build the `<section class="footnotes">` that goes under the cloned table,
   * containing a copy of every definition the clone's markers actually point
   * at. Returns `null` — the "behave exactly as before" path — whenever there
   * is nothing to show: no markers at all, no note root, no rendered `.footnotes`
   * (Live Preview, and reading-view sections Obsidian has virtualised away), or
   * no marker whose target resolves. On every one of those paths the clone is
   * returned untouched, so the overlay really is byte-identical to the one built
   * before footnote support existed — hence the strict split below between a
   * read-only resolution pass and the mutating pass that runs only once the
   * section is certain to be emitted. Individual unresolvable markers (a *mixed*
   * note, where some definitions did resolve) stay visible but are made inert;
   * there is deliberately no `Notice`, because in those modes the note itself
   * cannot show the text either.
   */
  _buildFootnotes(
    clone: HTMLElement,
    defs: Map<string, HTMLElement>
  ): HTMLElement | null {
    const refs = clone.querySelectorAll<HTMLAnchorElement>(FN_REF);
    if (refs.length === 0) return null;
    // Nothing can resolve, so nothing may be marked up: Live Preview never
    // renders a definition list, and neither does a reading-view note whose
    // `.footnotes` section is currently virtualised away.
    if (defs.size === 0) return null;

    // Pass 1 — strictly read-only over the clone. Keyed by href fragment, so a
    // footnote referenced twice is emitted once, in first-reference order.
    const picked = new Map<string, HTMLElement>();
    const resolved: HTMLAnchorElement[] = [];
    const unresolved: HTMLAnchorElement[] = [];
    refs.forEach((a) => {
      // The raw attribute, never `a.hash`: an unresolved href is not a URL.
      const href = a.getAttribute("href") ?? "";
      const key = href.slice(1);
      const def = key ? defs.get(key) : undefined;
      if (!def) {
        unresolved.push(a);
        return;
      }
      resolved.push(a);
      if (!picked.has(key)) picked.set(key, def);
    });
    if (picked.size === 0) return null;

    const section = el("section", "footnotes lookout-fs-footnotes");
    const list = el("ol");
    picked.forEach((def) => {
      const li = def.cloneNode(true);
      if (!li.instanceOf(HTMLLIElement)) return;
      // The list is a *subset* of the note's definitions, so the numbering has
      // to be carried over explicitly — otherwise a table referencing only
      // footnote 3 would render it as "1." under a marker reading "[3]".
      const ol = def.parentElement;
      if (ol && ol.instanceOf(HTMLOListElement)) {
        const idx = Array.prototype.indexOf.call(ol.children, def);
        if (idx >= 0) li.value = (ol.start || 1) + idx;
      }
      li.setAttribute("tabindex", "-1");
      list.appendChild(li);
    });
    if (!list.firstChild) return null;

    // Pass 2 — the section is going to be emitted, so the clone may be touched.
    resolved.forEach((a) => {
      // Never let a footnote marker open a browser window from the overlay.
      a.removeAttribute("target");
      a.removeAttribute("rel");
    });
    unresolved.forEach((a) => {
      a.removeAttribute("href");
      a.removeAttribute("target");
      a.removeAttribute("rel");
      a.setAttribute("aria-disabled", "true");
      a.addClass("lookout-fn-unresolved");
      a.setAttribute("aria-label", "각주 내용을 찾을 수 없습니다");
      a.title = "각주 내용을 찾을 수 없습니다";
    });

    section.appendChild(list);
    this._scrub(section);
    return section;
  }

  /*
   * Re-point every footnote identity and `#`-href inside `root` at an
   * overlay-local namespace, and return the resulting id → node map used for
   * jumps. Must run while `root` is still detached, so the document never holds
   * duplicate ids — not even for a frame.
   */
  _namespace(root: HTMLElement, prefix: string): Map<string, HTMLElement> {
    const targets = new Map<string, HTMLElement>();
    root.querySelectorAll<HTMLElement>(FN_IDENTIFIED).forEach((node) => {
      const base = node.id || node.getAttribute("data-footnote-id") || "";
      if (!base) return;
      const id = prefix + base;
      node.id = id;
      if (node.hasAttribute("data-footnote-id")) {
        node.setAttribute("data-footnote-id", id);
      }
      // Programmatic focus target only; never in the tab order.
      node.setAttribute("tabindex", "-1");
      targets.set(id, node);
    });
    root.querySelectorAll<HTMLAnchorElement>(FN_ANCHOR).forEach((a) => {
      const href = a.getAttribute("href") ?? "";
      if (href.startsWith("#")) a.setAttribute("href", "#" + prefix + href.slice(1));
      // The anchor gets no id of its own (see FN_IDENTIFIED), but its stale
      // `data-footnote-id` still names a node in the note; re-point it so the
      // overlay never advertises a note-scoped footnote identity.
      const fid = a.getAttribute("data-footnote-id");
      if (fid) a.setAttribute("data-footnote-id", prefix + fid);
      a.removeAttribute("target");
      a.removeAttribute("rel");
    });
    return targets;
  }

  openFullscreen() {
    if (this.overlay) return;
    const overlay = el("div", "lookout-fs lookout-fs--table");
    this.overlay = overlay;

    // The clone lives outside the note, so Obsidian's table styling (borders,
    // padding, header) — scoped to `.markdown-rendered` — would not reach it.
    // Give the scroll container that class so the clone inherits the same
    // styling as the inline view (no extra wrapper, no `display: contents`).
    const scroll = el("div", "lookout-table-fs-scroll markdown-rendered");
    const clone = this.table.cloneNode(true) as HTMLTableElement;
    clone.classList.add("lookout-table-fs-table");
    // Drops the Live Preview editor's drag handles/menu buttons that came along
    // with the clone (stray ":::"/"⋮" marks) plus any Lookout chrome.
    this._scrub(clone);

    // Footnote definitions live outside the <table>, so they have to be carried
    // in explicitly. `notes === null` is the common case and every failure case:
    // the overlay is then assembled exactly as it was before footnote support
    // existed — no wrapper, no namespacing, no click handling.
    let docEl: HTMLElement | null = null;
    const notes = this._buildFootnotes(clone, this._collectDefs());
    if (!notes) {
      scroll.appendChild(clone);
    } else {
      docEl = el("div", "lookout-fs-doc");
      docEl.appendChild(clone);
      docEl.appendChild(notes);
      scroll.appendChild(docEl);
      // Namespace while still detached — see `_namespace`.
      this.fsTargets = this._namespace(docEl, `lookout-fs-${++fsSeq}-`);
      overlay.addEventListener("click", this.onFsAnchorClick);
      overlay.addEventListener("auxclick", this.onFsAnchorClick);
    }

    overlay.appendChild(scroll);

    const close = el("button", "lookout-btn lookout-fs-close");
    close.type = "button";
    close.appendChild(svgIcon("close"));
    close.setAttribute("aria-label", "닫기");
    close.title = "닫기 (Esc)";
    close.addEventListener("click", this.onCloseFs);
    overlay.appendChild(close);

    // Click on the empty backdrop (not the table, not the footnotes) closes the
    // view. The wrapper counts as backdrop: it hugs the table, so anything to
    // the side of it is empty space.
    overlay.addEventListener("pointerdown", (e) => {
      if (e.target === overlay || e.target === scroll || (docEl && e.target === docEl)) {
        this.onCloseFs();
      }
    });

    activeDocument.body.appendChild(overlay);
    activeDocument.addEventListener("keydown", this.onFsKeyDown, true);
    close.focus({ preventScroll: true });
  }

  /*
   * Delegated on the overlay, so it dies with it. Only the anchors we
   * namespaced are ours to handle: the fragment is looked up in `fsTargets` by
   * string equality — no selector is ever built from a user-authored label, so
   * a malformed one cannot throw — and anything that does not resolve there
   * (an internal link or an external URL sitting in a cell) is left with
   * exactly the behaviour it had before footnote support existed. Registering
   * `auxclick` too covers middle-click; the modifier variants are cancelled
   * here before Obsidian's own delegated handlers ever see them.
   */
  onFsAnchorClick = (e: MouseEvent) => {
    const target = e.target as Element | null;
    if (!target || !target.instanceOf(HTMLElement)) return;
    const a = target.closest("a");
    if (!a || !a.instanceOf(HTMLAnchorElement)) return;
    if (!this.overlay || !this.overlay.contains(a)) return;

    const href = a.getAttribute("href") ?? "";
    const id = href.startsWith("#") ? href.slice(1) : "";
    if (!id || !this.fsTargets || !this.fsTargets.has(id)) return;

    e.preventDefault();
    e.stopPropagation();
    this._jumpTo(id);
  }

  /* Scroll a namespaced footnote node into view and flag it briefly. */
  _jumpTo(id: string) {
    const node = this.fsTargets?.get(id);
    if (!node) return;
    node.scrollIntoView({
      block: "center",
      behavior: REDUCED_MOTION ? "auto" : "smooth",
    });
    node.focus({ preventScroll: true });
    if (this.fsHighlightTimer !== null) window.clearTimeout(this.fsHighlightTimer);
    this.overlay
      ?.querySelectorAll(".is-lookout-target")
      .forEach((n) => n.removeClass("is-lookout-target"));
    node.addClass("is-lookout-target");
    this.fsHighlightTimer = window.setTimeout(() => {
      this.fsHighlightTimer = null;
      node.removeClass("is-lookout-target");
    }, 1400);
  }

  onFsKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      this.onCloseFs();
    }
  }

  onCloseFs = () => {
    if (!this.overlay) return;
    if (this.fsHighlightTimer !== null) {
      window.clearTimeout(this.fsHighlightTimer);
      this.fsHighlightTimer = null;
    }
    activeDocument.removeEventListener("keydown", this.onFsKeyDown, true);
    // Removing the overlay takes the click/auxclick/pointerdown listeners with it.
    this.overlay.remove();
    this.overlay = null;
    this.fsTargets = null;
    // Return focus to the trigger — but not on the `destroy()` path, which
    // closes first and then detaches the host the button lives in.
    if (!this.destroyed && this.fsBtn && this.fsBtn.isConnected) {
      this.fsBtn.focus({ preventScroll: true });
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.onCloseFs();
    // Restore the table to its original place so unloading is clean.
    if (this.host && this.host.parentElement) {
      this.host.parentElement.insertBefore(this.table, this.host);
      this.host.remove();
    }
  }
}

/* =====================================================================
 * Plugin: find rendered Mermaid svgs and wide tables; wrap each.
 * ===================================================================== */
const PROCESSED = "data-lookout";

export default class LookoutPlugin extends Plugin {
  views!: Set<DiagramView | TableView>;
  observer?: MutationObserver;
  private _scanQueued = false;

  onload() {
    this.views = new Set();
    this._scanQueued = false;

    this.app.workspace.onLayoutReady(() => this.scan());

    const relayout = () => this.queueScan();
    this.registerEvent(this.app.workspace.on("layout-change", relayout));
    this.registerEvent(this.app.workspace.on("active-leaf-change", relayout));
    this.registerEvent(
      this.app.workspace.on("file-open", () => {
        window.setTimeout(() => this.scan(), 200);
      })
    );

    // Mermaid renders asynchronously; catch svgs as they appear.
    this.observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of Array.from(m.addedNodes)) {
          if (node.instanceOf(HTMLElement) || node.instanceOf(SVGElement)) {
            this.queueScan();
            return;
          }
        }
      }
    });
    this.observer.observe(activeDocument.body, { childList: true, subtree: true });

    this.registerMarkdownPostProcessor((elm) => {
      window.setTimeout(() => this.scanWithin(elm), 50);
    });

    this.addCommand({
      id: "fullscreen-first-diagram",
      name: "활성 노트의 첫 Mermaid 다이어그램을 전체 화면으로 열기",
      callback: () => this.fullscreenFirst(),
    });
  }

  onunload() {
    if (this.observer) this.observer.disconnect();
    for (const v of this.views) v.destroy();
    this.views.clear();
  }

  queueScan() {
    if (this._scanQueued) return;
    this._scanQueued = true;
    window.setTimeout(() => {
      this._scanQueued = false;
      this.scan();
    }, 120);
  }

  scan() {
    this.scanWithin(activeDocument.body);
  }

  scanWithin(root: ParentNode | null) {
    if (!root) return;
    const svgs = root.querySelectorAll<SVGSVGElement>(
      '.mermaid svg, svg[id^="mermaid-"]'
    );
    svgs.forEach((svg) => this.process(svg));
    const tables = root.querySelectorAll("table");
    tables.forEach((table) => this.processTable(table));
  }

  process(svg: SVGSVGElement) {
    if (svg.hasAttribute(PROCESSED)) return;
    if (svg.closest(".lookout-viewport") || svg.closest(".lookout-fs")) return;
    const parent = svg.parentElement;
    if (!parent) return;
    // Ignore stray/placeholder svgs with no usable size source.
    const vb = svg.viewBox && svg.viewBox.baseVal;
    const r = svg.getBoundingClientRect();
    if (!(vb && vb.width) && !r.width) return;

    svg.setAttribute(PROCESSED, "1");

    const anchor = svg.nextSibling; // captured before the svg is moved into the stage
    const view = new DiagramView(svg, { fullscreen: false, parent, anchor });
    this.views.add(view);
  }

  processTable(table: HTMLTableElement) {
    if (table.hasAttribute(PROCESSED)) return;
    if (table.closest(".lookout-table-host") || table.closest(".lookout-fs")) return;
    // Enhance rendered tables in a note — both reading view (.markdown-rendered)
    // and Live Preview, where Obsidian renders the table as a CM widget under
    // .markdown-source-view. (Requiring .markdown-rendered alone skipped Live
    // Preview, Obsidian's default mode, so the button never appeared there.)
    if (!table.closest(".markdown-rendered, .markdown-source-view")) return;
    // ...but never the *editable* table while the cursor is inside it in Live
    // Preview: those cells are contenteditable and Obsidian owns that DOM.
    if (table.querySelector('[contenteditable="true"]')) return;
    const parent = table.parentElement;
    if (!parent) return;

    table.setAttribute(PROCESSED, "1");
    const anchor = table.nextSibling; // captured before the table is moved into the host
    const view = new TableView(table, { parent, anchor });
    this.views.add(view);
  }

  fullscreenFirst() {
    const view = [...this.views].find(
      (v): v is DiagramView =>
        v instanceof DiagramView &&
        !v.fs &&
        activeDocument.body.contains(v.viewport)
    );
    if (view) {
      view.openFullscreen();
    } else {
      new Notice("이 노트에서 Mermaid 다이어그램을 찾지 못했습니다.");
    }
  }
}
