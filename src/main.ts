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
    // Drop the Live Preview editor's drag handles/menu buttons that came along
    // with the clone — they would otherwise show as stray ":::"/"⋮" marks.
    clone.querySelectorAll(TABLE_EDITOR_CHROME).forEach((node) => node.remove());
    scroll.appendChild(clone);
    overlay.appendChild(scroll);

    const close = el("button", "lookout-btn lookout-fs-close");
    close.type = "button";
    close.appendChild(svgIcon("close"));
    close.setAttribute("aria-label", "닫기");
    close.title = "닫기 (Esc)";
    close.addEventListener("click", this.onCloseFs);
    overlay.appendChild(close);

    // Click on the empty backdrop (not the table) closes the view.
    overlay.addEventListener("pointerdown", (e) => {
      if (e.target === overlay || e.target === scroll) this.onCloseFs();
    });

    activeDocument.body.appendChild(overlay);
    activeDocument.addEventListener("keydown", this.onFsKeyDown, true);
    close.focus({ preventScroll: true });
  }

  onFsKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      this.onCloseFs();
    }
  }

  onCloseFs = () => {
    if (!this.overlay) return;
    activeDocument.removeEventListener("keydown", this.onFsKeyDown, true);
    this.overlay.remove();
    this.overlay = null;
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
