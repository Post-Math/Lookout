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

import {
  App,
  Component,
  FootnoteCache,
  MarkdownRenderer,
  MarkdownView,
  Notice,
  Plugin,
  TFile,
} from "obsidian";

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
  typeof activeWindow !== "undefined" &&
  !!activeWindow.matchMedia &&
  activeWindow.matchMedia("(prefers-reduced-motion: reduce)").matches;

/*
 * What Tab may reach inside a full-screen overlay. Deliberately narrow: the
 * footnote definitions carry `tabindex="-1"` as programmatic jump targets and
 * must stay out of the tab order, and an unresolvable marker has had its `href`
 * stripped, which already makes it unfocusable.
 */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]),' +
  ' textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Keep Tab inside `overlay`. A full-screen overlay covers the workspace, so
 * without this the first Tab walks onto the note's own links and buttons behind
 * it — focus lands somewhere the reader cannot see, and the next Enter
 * activates it. Obsidian's own modals do not do this, but they are small
 * centred dialogs the reader can see past; ours is the whole screen.
 *
 * Visibility is tested with `getClientRects()`, not `offsetParent`: the close
 * button is `position: fixed`, for which `offsetParent` is always null.
 */
function trapTab(overlay: HTMLElement, e: KeyboardEvent) {
  if (e.key !== "Tab") return;
  const items = Array.from(
    overlay.querySelectorAll<HTMLElement>(FOCUSABLE)
  ).filter((n) => n.getClientRects().length > 0);
  // Nothing to land on — swallow Tab rather than let it escape the overlay.
  if (!items.length) {
    e.preventDefault();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const active = activeDocument.activeElement;
  const inside = !!active && overlay.contains(active);
  if (e.shiftKey ? active === first || !inside : active === last || !inside) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus({ preventScroll: true });
  }
}

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
      // A modal surface: it covers the workspace, so say so rather than leave
      // assistive tech to announce the note underneath as if it were reachable.
      this.overlay.setAttribute("role", "dialog");
      this.overlay.setAttribute("aria-modal", "true");
      this.overlay.setAttribute("aria-label", "Mermaid 다이어그램 전체 화면");
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
    return Math.round(activeWindow.innerHeight * INLINE_MAX_VH);
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
    if (this.fs && this.overlay) {
      trapTab(this.overlay, e);
      if (e.key === "Tab") return;
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
  /** for metadataCache / vault reads and MarkdownRenderer's sourcePath */
  app: App;
}

/** One footnote marker occurrence inside the cloned table. */
interface FnRef {
  /** the cloned marker anchor — a live node in the clone */
  a: HTMLAnchorElement;
  /** `a.closest("sup.footnote-ref")` — the node a back-ref jumps to */
  sup: HTMLElement | null;
  /** the ORIGINAL href minus '#', e.g. "fn-3-c0a3ab87fc97df88" */
  fragment: string;
  /** `data-footref` — the join key into the metadata cache, e.g. "dup" / "[inline5" */
  id: string;
  /** the displayed footnote number */
  num: number;
}

/** One resolved definition, ready to render. */
interface FnDef {
  num: number;
  fragment: string;
  markdown: string;
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
 * footnote mechanism relies on beyond the <table> subtree — Obsidian's own
 * scoped click handlers, the `#fn-…`/`#fnref-…` id anchors — is unreachable
 * from the overlay.
 *
 * The definitions are *not* read from the rendered DOM. Obsidian does not
 * render off-screen sections, and a note's footnote section sits at the very
 * bottom while the table sits above it, so `.footnotes` is simply absent from
 * the document for every table but the note's last one (and absent always in
 * Live Preview, which renders each block in isolation). We therefore resolve
 * every definition from the note's **source**: `metadataCache.getFileCache()`
 * gives `{ id, position }` per footnote, `data-footref` on the marker is the
 * join key, `vault.cachedRead()` supplies the text, and `MarkdownRenderer`
 * renders it into the overlay. Everything below feeds that.
 */

/** A footnote reference marker inside a cell — never the definition's back-ref. */
const FN_REF = 'a.footnote-link:not(.footnote-backref)[href^="#"]';
/** Every footnote anchor in the overlay (refs *and* back-refs) needs re-pointing. */
const FN_ANCHOR = 'a.footnote-link[href^="#"]';
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
  /** for metadataCache / vault reads and MarkdownRenderer's sourcePath */
  app: App;
  destroyed: boolean;
  host!: HTMLDivElement;
  scroll!: HTMLDivElement;
  overlay: HTMLDivElement | null = null;
  /** the inline trigger, kept so focus can return to it when the overlay closes */
  fsBtn!: HTMLButtonElement;
  /** namespaced footnote id → the node in the overlay it now identifies */
  fsTargets: Map<string, HTMLElement> | null = null;
  fsHighlightTimer: number | null = null;
  /** whether the current overlay was dismissed by keyboard, so focus must return to the trigger */
  fsCloseByKeyboard = false;
  /**
   * Owns the lifecycle of everything `MarkdownRenderer` builds inside the
   * overlay. Live only while an overlay is open; unloaded in `onCloseFs`.
   */
  fsComponent: Component | null = null;

  constructor(table: HTMLTableElement, options: TableViewOptions) {
    this.table = table;
    this.parent = options.parent;
    this.anchor = options.anchor;
    this.app = options.app;
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
   * The file whose source carries this table's footnote definitions.
   *
   * The embed branch comes first and never falls through to the host: an
   * embedded note's markers must resolve against the *embedded* file, and
   * rendering the host note's footnote text under them would be wrong text
   * under right markers — strictly worse than showing nothing.
   *
   * `workspace.getActiveFile()` is deliberately never used: a background pane,
   * a hover popover or an embed would silently resolve to whatever note happens
   * to be focused. Walking from this table's own leaf is the only resolution
   * that cannot pick the wrong note.
   */
  _sourceFile(): TFile | null {
    const embed = this.table.closest(".internal-embed[src], .markdown-embed[src]");
    if (embed) {
      // Strip a `#heading` / `#^block` suffix; an unresolvable link is `null`,
      // which is the "no file" failure, never the host file.
      const linkpath = (embed.getAttribute("src") ?? "").split(/[#^]/)[0].trim();
      if (!linkpath) return null;
      return this.app.metadataCache.getFirstLinkpathDest(linkpath, this._hostPath());
    }
    return this._hostFile();
  }

  /** The `TFile` of the markdown leaf whose DOM contains this table. */
  _hostFile(): TFile | null {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.containerEl.contains(this.table)) {
        return view.file;
      }
    }
    return null;
  }

  _hostPath(): string {
    return this._hostFile()?.path ?? "";
  }

  /*
   * Every footnote marker occurrence in the clone, in document order. Must run
   * *before* `_namespace`, which rewrites the hrefs this reads.
   *
   * The metadata cache is in *definition* order while Obsidian numbers
   * footnotes in first-*reference* order, so the cache cannot supply the
   * number; the href fragment is per-definition (`[3]` and `[3-1]` share
   * `#fn-3-…`) while the link text is per-occurrence, so the href is the
   * reliable carrier of both the number and the dedupe key. This parses an
   * *undocumented* id format — the regex guard and the `Number.isInteger`
   * check are load-bearing, not defensive decoration: a marker we cannot number
   * gets no record at all and is hardened inert rather than emitted with the
   * wrong number.
   */
  _collectRefs(clone: HTMLElement): FnRef[] {
    const refs: FnRef[] = [];
    clone.querySelectorAll<HTMLAnchorElement>(FN_REF).forEach((a) => {
      // The raw attribute, never `a.hash`: an unresolved href is not a URL.
      const fragment = (a.getAttribute("href") ?? "").slice(1);
      if (!fragment) return;
      // Held as a live node reference into the clone: `_namespace` re-mints its
      // `id` in place afterwards, so reading `sup.id` later yields the
      // *namespaced* value — which is exactly what a back-ref must point at.
      const sup = a.closest<HTMLElement>("sup.footnote-ref");
      const id =
        a.getAttribute("data-footref") ?? sup?.getAttribute("data-footref") ?? "";
      if (!id) return;
      // An inline footnote's identifier is `[inline<n>`, and <n> counts within
      // the *parse* that produced the marker. Reading view parses the whole
      // file, so <n> is the same number the metadata cache assigned. Live
      // Preview parses each block on its own, so a table widget's first inline
      // footnote is `[inline0` however many the note carries above it, while
      // the cache still calls that one `[inline3` — joining the two renders a
      // *different* footnote's text under the right marker, which is strictly
      // worse than showing nothing. The block's offset in the file is not
      // recoverable from the widget (Obsidian emits `data-footref` and nothing
      // positional), so the index cannot be corrected and the join is refused:
      // the marker falls through to `_hardenAnchors` and goes inert. Live
      // Preview already does the same to reference-style markers on its own —
      // it degrades them to plain text before a marker is ever built — so no
      // footnote resolves there.
      if (id.startsWith("[") && this.table.closest(".markdown-source-view")) return;
      const num = this._refNumber(fragment, a);
      if (num === null) return;
      refs.push({ a, sup, fragment, id, num });
    });
    return refs;
  }

  /** The displayed footnote number, from the href fragment or the link text. */
  _refNumber(fragment: string, a: HTMLAnchorElement): number | null {
    const m = /^fn-(\d+)(?:-|$)/.exec(fragment);
    let raw = m ? m[1] : "";
    if (!raw) {
      // Fallback for a renderer that does not use the `fn-<N>-<docId>` shape:
      // the visible "[3]" / "[3-1]", of which only the leading segment is the
      // footnote's number (the suffix counts the occurrence).
      const text = (a.textContent || "").trim().replace(/^\[/, "").replace(/\]$/, "");
      raw = text.split("-")[0];
    }
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
  }

  /*
   * Clone hygiene: strip the Live Preview editor chrome and any of Lookout's
   * own controls that rode along, then unwrap Lookout's wrappers so their
   * contents survive as plain rendered markup. Idempotent, and safe to run on
   * anything — outer wrappers are unwrapped before inner ones (the NodeList is
   * static and in document order) and children move into the still-attached
   * grandparent, so nothing is orphaned.
   *
   * It also drops every *document-level* `id` the clone carried over — a
   * table's `^block-id`, anything id-bearing in a cell — except the footnote
   * identity nodes `_namespace` re-mints. Without this the overlay would put a
   * second copy of those ids in the document for as long as it is open —
   * invalid DOM, and enough to send an in-note `#…` link to the clone instead
   * of the note. Ids *inside an SVG subtree are deliberately kept*, because
   * id-scoped `<style>`, `<use>`, gradient/marker/clip-path references break
   * outright without them, whereas a duplicated svg-internal id is benign
   * (same-document `url(#…)` resolves to an identical definition).
   */
  _scrub(root: HTMLElement) {
    root.querySelectorAll(TABLE_EDITOR_CHROME).forEach((node) => node.remove());
    root.querySelectorAll(LOOKOUT_CHROME).forEach((node) => node.remove());
    // Undo the inline sizing `DiagramView._build` stamped on a wrapped svg
    // before the wrapper that clipped it is unwrapped away: a cloned 1600px
    // diagram would otherwise render unscaled and overflow the overlay's
    // scroll container. (`DiagramView.openFullscreen` performs the same reset
    // on its own clone.)
    root.querySelectorAll<SVGSVGElement>(".lookout-stage svg").forEach((s) =>
      s.setCssStyles({ width: "", height: "", maxWidth: "", display: "" })
    );
    root.querySelectorAll(LOOKOUT_WRAPPERS).forEach((wrap) => {
      const parent = wrap.parentElement;
      if (!parent) return;
      while (wrap.firstChild) parent.insertBefore(wrap.firstChild, wrap);
      wrap.remove();
    });
    if (root.id && root.namespaceURI !== SVG_NS && !root.matches(FN_IDENTIFIED)) {
      root.removeAttribute("id");
    }
    root.querySelectorAll("[id]").forEach((node) => {
      // Namespace test, not `closest("svg")`: an HTML element inside a
      // `<foreignObject>` is not svg-internal and must still be stripped.
      if (node.namespaceURI === SVG_NS) return;
      if (!node.matches(FN_IDENTIFIED)) node.removeAttribute("id");
    });
  }

  /*
   * The single "this footnote anchor cannot be resolved here" treatment. An
   * href-less `<a>` computes ARIA role `generic`, on which `aria-label` is
   * *prohibited* (name-from-author disallowed) — so the explanation would never
   * reach a screen reader and the only remaining cue would be colour. Restoring
   * `role="link"` gives it an author-nameable role again, so both the label and
   * `aria-disabled` are honoured. Idempotent by construction.
   */
  _makeInert(a: HTMLAnchorElement) {
    a.removeAttribute("href");
    a.removeAttribute("target");
    a.removeAttribute("rel");
    a.setAttribute("role", "link");
    a.setAttribute("aria-disabled", "true");
    // A back-ref's visible text is the "↩︎" glyph, which names nothing; a
    // marker's is its number, and the name has to *contain* it rather than
    // replace it — a bare "내용을 찾을 수 없습니다" erases the "[1]" for anyone
    // who cannot see the glyph it sits on.
    const marker = (a.textContent || "").trim();
    const label = a.classList.contains("footnote-backref")
      ? "돌아갈 각주 참조가 이 화면에 없습니다"
      : marker
        ? `각주 ${marker} — 내용을 찾을 수 없습니다`
        : "각주 내용을 찾을 수 없습니다";
    a.setAttribute("aria-label", label);
    a.title = label;
    a.classList.add("lookout-fn-unresolved");
  }

  /*
   * The one sweep that decides which footnote anchors survive as links. The
   * predicate is FN_ANCHOR, not FN_REF, on purpose: it also covers "↩︎"
   * back-refs — the ones we author (whose targets are in `targets` by
   * construction) and any a rendered definition body happens to contain itself.
   * A footnote anchor left live without a target in the overlay looks
   * clickable, does nothing, and lets the browser set `location.hash` and push
   * a history entry on the Obsidian window. An ordinary link in a cell is never
   * matched. `targets === null` means nothing can resolve at all.
   */
  _hardenAnchors(root: HTMLElement, targets: Map<string, HTMLElement> | null) {
    root.querySelectorAll<HTMLAnchorElement>(FN_ANCHOR).forEach((a) => {
      const href = a.getAttribute("href") ?? "";
      const id = href.startsWith("#") ? href.slice(1) : "";
      if (id && targets && targets.has(id)) return;
      this._makeInert(a);
    });
  }

  /*
   * Remove a reference-style definition's leading `[^<id>]:` label and the
   * whitespace after it. Without this the rendered markdown would *again* be a
   * footnote definition and the body would disappear into a list Obsidian does
   * not render here.
   *
   * Never compile a regex from `id`: measured ids include the inline form
   * `[inline5`, which is regex-hostile. `startsWith` is exact and cannot throw.
   * The strip is prefix-conditional, so an inline definition's slice (which
   * carries no label at all) is left untouched.
   */
  _stripDefLabel(text: string, id: string): string {
    const head = "[^" + id + "]";
    if (!text.startsWith(head)) return text;
    let i = head.length;
    if (text[i] === ":") i++;
    while (text[i] === " " || text[i] === "\t") i++;
    return text.slice(i);
  }

  /*
   * Drop exactly one leading 4-space (or one tab) indent from every line after
   * the first. A multi-line definition's continuation lines are indented in the
   * source, so without this a ```` ```mermaid ```` fence sits at 4 spaces and
   * Markdown parses it as an *indented code block* — a grey blob instead of a
   * diagram. Exactly one unit per line, never a computed minimum: a line
   * indented 8 spaces (a nested list) must keep 4, and a lazily continued line
   * with 0–3 spaces must be left alone.
   */
  /*
   * A definition's rendered text, flattened to one line for a `title` tooltip.
   * Capped because a native tooltip has no scroll and a long footnote would
   * paint a wall across the overlay; the full text is always one click away in
   * the list below the table.
   */
  _previewText(li: HTMLElement): string {
    const text = (li.textContent || "").replace(/\s+/g, " ").trim();
    return text.length > 300 ? text.slice(0, 299).trimEnd() + "…" : text;
  }

  _dedent(text: string): string {
    const lines = text.split("\n");
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].startsWith("    ")) lines[i] = lines[i].slice(4);
      else if (lines[i].startsWith("\t")) lines[i] = lines[i].slice(1);
    }
    return lines.join("\n");
  }

  /*
   * Is `source[start, end)` really an inline definition's body?
   *
   * An inline footnote's cached position is its `contentPosition` — the span of
   * its children, i.e. the body *without* the surrounding `^[` and `]` — so an
   * honest slice is still bracketed by them in the source. The cache is read
   * synchronously while `cachedRead` is awaited, and Obsidian's index lags the
   * file content, so between an edit and the reindex the offsets can name a
   * region of the note that is not a footnote at all; without this check that
   * arbitrary prose renders as the footnote's body. This is the inline
   * counterpart of the `[^id]` prefix test reference-style slices get.
   *
   * Whitespace is tolerated on both sides: `^[ 본문 ]` is legal markdown and
   * whether the padding falls inside `contentPosition` is not ours to assume.
   * `slice` with a negative start is harmless — it yields "" and fails.
   */
  _isInlineBody(source: string, start: number, end: number): boolean {
    let i = start;
    while (i > 0 && (source[i - 1] === " " || source[i - 1] === "\t")) i--;
    if (source.slice(i - 2, i) !== "^[") return false;
    let j = end;
    while (j < source.length && (source[j] === " " || source[j] === "\t")) j++;
    return source[j] === "]";
  }

  /*
   * file → cache → source → join → slice → normalise. One `cachedRead` per
   * overlay open, shared by every definition.
   *
   * A miss never collapses the section: an unknown label, a stale offset or an
   * empty body drops *that one* definition and leaves every other one to build,
   * so a single bad footnote cannot make a whole table look unsupported.
   */
  async _resolveDefs(refs: FnRef[]): Promise<{ sourcePath: string; defs: FnDef[] }> {
    const defs: FnDef[] = [];
    const file = this._sourceFile();
    // No backing file — a canvas, a plugin view, a popover, an embed whose
    // `src` does not resolve. Nothing to read; every marker goes inert.
    if (!file) return { sourcePath: "", defs };
    const footnotes = this.app.metadataCache.getFileCache(file)?.footnotes;
    if (!footnotes) return { sourcePath: file.path, defs };

    const source = await this.app.vault.cachedRead(file);
    const byId = new Map<string, FootnoteCache>();
    for (const fn of footnotes) if (!byId.has(fn.id)) byId.set(fn.id, fn);

    // Deduped by *fragment*, first occurrence wins: `[3]` and `[3-1]` share
    // `#fn-3-…`, and the overlay must list that definition once.
    const seen = new Set<string>();
    for (const ref of refs) {
      if (seen.has(ref.fragment)) continue;
      seen.add(ref.fragment);
      const fn = byId.get(ref.id);
      if (!fn) continue;
      const start = fn.position.start.offset;
      const end = fn.position.end.offset;
      // A stale cache can point past EOF; slicing that would render garbage.
      if (!(start >= 0 && start < end && end <= source.length)) continue;
      const slice = source.slice(start, end);
      // Staleness validation, structural on both sides of the fork: measured
      // inline ids all begin with "[", so an id that does not is
      // reference-style and its slice *must* carry its own `[^id]` label, while
      // an inline one must still be bracketed by `^[` … `]` in the source. If
      // either fails, the cache offsets disagree with what `cachedRead` just
      // returned (indexing mid-update) and the slice is somebody else's text —
      // drop it, and let the marker go inert.
      if (ref.id.startsWith("[")) {
        if (!this._isInlineBody(source, start, end)) continue;
      } else if (!slice.startsWith("[^" + ref.id + "]")) continue;
      const markdown = this._dedent(this._stripDefLabel(slice, ref.id));
      if (!markdown.trim()) continue;
      defs.push({ num: ref.num, fragment: ref.fragment, markdown });
    }

    // Ascending by the marker's own number, which reproduces the note's own
    // footnote section: Obsidian renders that as an ascending <ol>, so a
    // numeric sort over a subset of it matches. A table whose first cell
    // references [^2] and a later cell [^1] must still emit "1." above "2.".
    defs.sort((a, b) => a.num - b.num);
    return { sourcePath: file.path, defs };
  }

  /*
   * Build the `<section class="footnotes">` that goes under the cloned table,
   * rendering each resolved definition's *markdown* with Obsidian's own
   * renderer. Returns `null` when nothing could be built.
   *
   * Everything happens on a fully detached section, so the detached-until-clean
   * invariant holds for every id minted here: the document never carries a
   * duplicate id, not even for a frame, and a half-built section is never
   * visible. (If a code-block post-processor is ever found to need an attached
   * node — a Mermaid fence inside a footnote rendering blank — the one
   * documented remedy is to append the empty `section` to the overlay before
   * this loop and keep every other step in the same order.)
   */
  private async _buildFootnotes(
    defs: FnDef[],
    refs: FnRef[],
    prefix: string,
    targets: Map<string, HTMLElement>,
    sourcePath: string
  ): Promise<HTMLElement | null> {
    // One Component per overlay owns every MarkdownRenderChild the renders
    // below create. Assigned to the field *before the first await*, so a close
    // during rendering always finds it and can unload it.
    const component = new Component();
    component.load();
    this.fsComponent = component;

    const section = el("section", "footnotes lookout-fs-footnotes");
    const list = el("ol");
    // Appended now, not after the loop: `_scrub` below must see the items.
    section.appendChild(list);

    const items: HTMLLIElement[] = [];
    for (const def of defs) {
      const li = el("li");
      list.appendChild(li);
      // `sourcePath` is the *resolved* file, so a link or embed inside a
      // footnote resolves against the note the footnote came from — which is
      // the embedded note, not the host, when the table sits in an embed.
      await MarkdownRenderer.render(this.app, def.markdown, li, sourcePath, component);
      // The overlay may have closed (or been closed and re-opened) while that
      // awaited; the close already unloaded this component, and a newer one may
      // now own the field, so bail without touching it.
      if (this.fsComponent !== component) return null;
      items.push(li);
    }

    // Deliberately before the ids below are stamped: `_scrub`'s `[id]` sweep
    // exempts FN_IDENTIFIED (which includes `.footnotes li[id]`), and scrubbing
    // first breaks that implicit coupling, so a future rename cannot silently
    // start eating our own ids. It is still required — rendered markdown
    // carries ids (headings, block refs, embedded content) that must not enter
    // the document a second time.
    this._scrub(section);

    defs.forEach((def, i) => {
      const li = items[i];
      li.id = prefix + def.fragment;
      li.setAttribute("data-footnote-id", li.id);
      // Programmatic focus target only; never in the tab order.
      li.setAttribute("tabindex", "-1");
      // The list is a *subset* of the note's definitions, so the numbering has
      // to be carried explicitly — otherwise a table referencing only footnote
      // 3 would render it as "1." under a marker reading "[3]".
      li.value = def.num;
      targets.set(li.id, li);

      // Read before the back-refs below are appended, so the preview does not
      // trail a "↩︎" that means nothing out of context.
      const preview = this._previewText(li);

      // One back-ref per marker occurrence *present in the clone*, keyed to
      // that occurrence's own <sup> rather than to the href the occurrences
      // share — so `[3]` and `[3-1]` get one back-ref each, landing on
      // different anchors. Occurrences outside the table produce nothing, so a
      // dead back-ref cannot exist by construction.
      for (const ref of refs) {
        if (ref.fragment !== def.fragment) continue;
        // Hovering a marker shows what it points at. Obsidian gives a footnote
        // no hover affordance of its own — its only footnote handler is a click
        // delegated on the note's preview sizer, which never sees this overlay
        // — and in full screen the definition can sit far below a long table,
        // so the marker is otherwise a number with nothing behind it until you
        // click. A plain `title` buys that: native, no listener, nothing to
        // clean up on close.
        if (preview) ref.a.title = preview;
        const sup = ref.sup;
        if (!sup || !sup.id) continue;
        const back = el("a", "footnote-backref footnote-link");
        back.textContent = "↩︎";
        // Already namespaced — `_namespace` re-minted `sup.id` in place.
        back.setAttribute("href", "#" + sup.id);
        // A lone "↩︎" is a nameless link; name it after the footnote it
        // returns from, as `_makeInert` does for the inert case.
        const label = `각주 ${def.num} 참조로 돌아가기`;
        back.setAttribute("aria-label", label);
        back.title = label;
        // Rendered markdown wraps a one-line definition in <p>, so appending to
        // the <li> would drop the glyph onto its own line below the paragraph.
        const last = li.lastElementChild;
        const host = last && last.matches("p, li, blockquote, div") ? last : li;
        host.appendChild(activeDocument.createTextNode(" "));
        host.appendChild(back);
      }
    });

    return list.firstChild ? section : null;
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
    // A modal surface: it covers the workspace, so say so rather than leave
    // assistive tech to announce the note underneath as if it were reachable.
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "표 전체 화면");
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

    // Footnote definitions live outside the <table> — in the note's *source* —
    // so they arrive asynchronously. Everything that decides how the clone
    // behaves is nevertheless settled here, synchronously:
    //
    // INVARIANT (detached-until-clean): everything that mints, strips or re-points a
    // footnote identity or a `#`-href runs while `overlay` is still detached, so the
    // document never holds a duplicate id — not even for a frame — and no anchor that
    // cannot resolve inside the overlay ever reaches the body with a live href.
    // Namespacing must therefore precede hardening: hardening decides "dead" by
    // looking the anchor's (already namespaced) fragment up in `fsTargets`.
    //
    // The FN_ANCHOR test, not FN_REF: a clone carrying only a stray back-ref
    // would otherwise skip namespacing and reach the body with a live `#fn-…`
    // href into the note, which is the very thing this guard exists to stop.
    // A table with no footnote anchor at all takes no wrapper, no attribute and
    // no listeners — a byte-identical overlay to the pre-footnote one.
    let docEl: HTMLElement | null = null;
    let refs: FnRef[] = [];
    let prefix = "";
    let targets: Map<string, HTMLElement> | null = null;
    let pending = false;
    if (clone.querySelector(FN_ANCHOR) === null) {
      scroll.appendChild(clone);
    } else {
      // Before `_namespace`, which rewrites the hrefs the raw fragments come from.
      refs = this._collectRefs(clone);
      prefix = `lookout-fs-${++fsSeq}-`;
      // Namespace while still detached — see `_namespace`.
      targets = this._namespace(clone, prefix);
      this.fsTargets = targets;
      docEl = el("div", "lookout-fs-doc");
      docEl.appendChild(clone);
      scroll.appendChild(docEl);
      overlay.addEventListener("click", this.onFsAnchorClick);
      overlay.addEventListener("auxclick", this.onFsAnchorClick);
      if (refs.length === 0) {
        // Markers exist but none carries a usable join key, so there is nothing
        // to resolve: settle synchronously rather than start a promise.
        this._hardenAnchors(docEl, targets);
        overlay.setAttribute("data-lookout-fn", "none");
      } else {
        // Set before the overlay is attached, so the settle signal is never
        // observed absent on a footnote-bearing overlay.
        overlay.setAttribute("data-lookout-fn", "pending");
        pending = true;
      }
    }

    overlay.appendChild(scroll);

    const close = el("button", "lookout-btn lookout-fs-close");
    close.type = "button";
    close.appendChild(svgIcon("close"));
    close.setAttribute("aria-label", "닫기");
    close.title = "닫기 (Esc)";
    // `detail === 0` is the standard "click synthesised from Enter/Space"
    // signal; a real pointer click reports `detail >= 1`. Only the keyboard
    // route wants focus handed back to the (normally invisible) trigger.
    close.addEventListener("click", (e) => {
      this.fsCloseByKeyboard = e.detail === 0;
      this.onCloseFs();
    });
    overlay.appendChild(close);

    // Click on the empty backdrop (not the table, not the footnotes) closes the
    // view. The wrapper counts as backdrop: it is `min(100%, 60ch)` wide, so
    // the strips beside a narrow table are bare wrapper — and those strips
    // belonged to `scroll` before this change, which the condition already
    // closed on.
    overlay.addEventListener("pointerdown", (e) => {
      if (e.target === overlay || e.target === scroll || (docEl && e.target === docEl)) {
        this.onCloseFs();
      }
    });

    activeDocument.body.appendChild(overlay);
    activeDocument.addEventListener("keydown", this.onFsKeyDown, true);
    this.fsCloseByKeyboard = false;
    close.focus({ preventScroll: true });

    // Last, and deliberately not awaited: `openFullscreen` runs from a click
    // handler and nothing awaits it, so an `async` signature would only add an
    // unhandled-rejection surface and would leave a window in which
    // `if (this.overlay) return` does not yet cover a second call.
    if (pending && docEl && targets) {
      void this._attachFootnotes(overlay, docEl, refs, prefix, targets);
    }
  }

  /*
   * The asynchronous half: resolve the definitions from the note's source,
   * render them, and settle `data-lookout-fn`. Everything the reader can touch
   * already exists by the time this runs; only the `<section>` arrives late.
   *
   * `alive()` after every await is the complete guard — the captured `overlay`
   * identity covers closed (`this.overlay === null`), closed-and-reopened (a
   * different object) and unloaded (`this.destroyed`), and `isConnected` covers
   * a detach by any other route. The `catch` exists because the only caller
   * `void`s this: an unguarded rejection would be invisible and would leave
   * `data-lookout-fn="pending"` as a terminal state, which it must never be.
   *
   * No failure raises a `Notice`, in any case. The failure is already announced
   * in place, per marker — dotted underline and muted colour for sighted
   * readers, `aria-disabled` plus a name containing the marker for assistive
   * tech. A global toast would misreport what is a per-marker condition, and it
   * would fire on every single open inside a surface that structurally has no
   * file (a canvas, a popover).
   */
  private async _attachFootnotes(
    overlay: HTMLElement,
    docEl: HTMLElement,
    refs: FnRef[],
    prefix: string,
    targets: Map<string, HTMLElement>
  ): Promise<void> {
    let section: HTMLElement | null = null;
    const alive = () =>
      !this.destroyed && this.overlay === overlay && overlay.isConnected;
    try {
      const { sourcePath, defs } = await this._resolveDefs(refs);
      if (!alive()) return;
      if (defs.length > 0) {
        section = await this._buildFootnotes(defs, refs, prefix, targets, sourcePath);
        if (!alive()) return;
        if (section) docEl.appendChild(section);
      }
    } catch {
      section = null;
    } finally {
      if (alive()) {
        // Does byte-for-byte what the old degradation path did, with fewer
        // branches: every anchor whose fragment is not in `targets` — a marker
        // whose definition never resolved, a back-ref a rendered body brought
        // along — goes inert here, markers and definitions in one sweep.
        this._hardenAnchors(docEl, targets);
        overlay.setAttribute("data-lookout-fn", section ? "ready" : "none");
      }
    }
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
    // `auxclick` fires for the secondary button too, and `contextmenu` has
    // already fired by then: a right-click on a marker would otherwise get the
    // context menu *and* an unrequested scroll + focus steal underneath it.
    if (e.type === "auxclick" && e.button !== 1) return;
    const target = e.target as Element | null;
    if (!target || !target.instanceOf(HTMLElement)) return;
    const a = target.closest("a");
    if (!a || !a.instanceOf(HTMLAnchorElement)) return;
    if (!this.overlay || !this.overlay.contains(a)) return;

    const href = a.getAttribute("href") ?? "";
    const id = href.startsWith("#") ? href.slice(1) : "";

    // Every footnote anchor is ours, resolved or not. Between "pending" and
    // "ready" a namespaced marker points at a node that does not exist yet, and
    // the browser default would set `location.hash` and push a history entry on
    // the Obsidian window. An ordinary link in a cell carries no
    // `.footnote-link`, so it keeps exactly the behaviour it always had.
    if (a.matches(FN_ANCHOR)) {
      e.preventDefault();
      e.stopPropagation();
      if (id && this.fsTargets?.has(id)) this._jumpTo(id);
      return;
    }

    // A link inside a rendered footnote body (an internal link, an external
    // URL) is left to Obsidian: the event path was computed at dispatch, so its
    // own delegated handler still navigates. Full screen closes on the *next*
    // turn — synchronously would tear down the overlay, and unload the
    // Component owning this link's MarkdownRenderChild, mid-click — so the
    // reader sees where they landed instead of finding the note moved under a
    // still-open overlay after Escape.
    if (a.closest(".lookout-fs-footnotes") && a.hasAttribute("href")) {
      const ov = this.overlay;
      window.setTimeout(() => {
        if (this.overlay === ov) this.onCloseFs();
      }, 0);
      return;
    }

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
      .forEach((n) => n.classList.remove("is-lookout-target"));
    node.classList.add("is-lookout-target");
    this.fsHighlightTimer = window.setTimeout(() => {
      this.fsHighlightTimer = null;
      node.classList.remove("is-lookout-target");
    }, 1400);
  }

  onFsKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      this.fsCloseByKeyboard = true;
      this.onCloseFs();
      return;
    }
    // Footnote definitions can arrive after the overlay opens, so the trap has
    // to read the overlay's focusables at keypress time, not at open time.
    if (this.overlay) trapTab(this.overlay, e);
  }

  onCloseFs = () => {
    if (!this.overlay) return;
    const restore = this.fsCloseByKeyboard;
    this.fsCloseByKeyboard = false;
    if (this.fsHighlightTimer !== null) {
      window.clearTimeout(this.fsHighlightTimer);
      this.fsHighlightTimer = null;
    }
    activeDocument.removeEventListener("keydown", this.onFsKeyDown, true);
    // Unload before the DOM goes: the component owns every MarkdownRenderChild
    // the rendered definitions created, and nulling the field is also what
    // tells a still-running render that its overlay is gone.
    if (this.fsComponent) {
      this.fsComponent.unload();
      this.fsComponent = null;
    }
    // Removing the overlay takes the click/auxclick/pointerdown listeners with it.
    this.overlay.remove();
    this.overlay = null;
    this.fsTargets = null;
    // Return focus to the trigger — but only when the close came from the
    // keyboard, and never on the `destroy()` path, which closes first and then
    // detaches the host the button lives in. After a *mouse* close the trigger
    // would be focused while `:focus-visible` does not match, i.e. invisible at
    // `opacity: 0`, and the next Space/Enter would re-open the overlay instead
    // of scrolling the note.
    if (restore && !this.destroyed && this.fsBtn && this.fsBtn.isConnected) {
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
    const view = new TableView(table, { parent, anchor, app: this.app });
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
