/*
 * Lookout — survey wide diagrams and tables in Obsidian.
 *
 * Mermaid diagrams: pan (wheel/drag), zoom (Ctrl+wheel/buttons), fit-to-frame,
 * and full screen. Tables: a full-screen button so wide tables can be read
 * without squinting through the note's horizontal scrollbar (no zoom).
 *
 * Plain CommonJS (no build step): Obsidian loads this file directly.
 * The visual language is a "drafting / survey instrument": Obsidian theme
 * surfaces with a single survey-cyan accent and a monospace zoom gauge.
 */

"use strict";

const obsidian = require("obsidian");

const PAD = 24;          // slack (px) so diagram edges can be panned just past the frame
const MIN_SCALE = 0.1;
const MAX_SCALE = 8;
const ZOOM_STEP = 1.2;   // per button press
const INLINE_FLOOR = 56; // min inline frame height (px) — just enough for the toolbar

/* ---- lucide-style icons, 1.75px stroke for a precise drafting feel ---- */
const ICONS = {
  minus: '<line x1="5" y1="12" x2="19" y2="12"/>',
  plus: '<line x1="5" y1="12" x2="19" y2="12"/><line x1="12" y1="5" x2="12" y2="19"/>',
  // "fit to frame": a frame with a horizontal double-arrow inside — distinct from the maximize glyph.
  fit: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7.5 12h9"/><path d="M10 9.5 7.5 12l2.5 2.5"/><path d="M14 9.5 16.5 12 14 14.5"/>',
  // "fullscreen": arrows pushing out to the four corners.
  full: '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
  close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
};

function svgIcon(name) {
  return (
    '<svg class="lookout-ico" viewBox="0 0 24 24" width="16" height="16" ' +
    'fill="none" stroke="currentColor" stroke-width="1.75" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    ICONS[name] +
    "</svg>"
  );
}

function el(tag, cls) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  return node;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const REDUCED_MOTION =
  typeof window !== "undefined" &&
  window.matchMedia &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * One pan/zoom controller around a single Mermaid <svg>.
 * Used both inline (wraps the rendered svg in place) and in full-screen
 * (wraps a clone inside a fixed overlay).
 */
class DiagramView {
  constructor(svg, options) {
    options = options || {};
    this.svg = svg;
    this.fs = !!options.fullscreen;
    this.onClose = options.onClose || null;
    this.parent = options.parent || null;   // inline: original parent of the svg
    this.anchor = options.anchor || null;    // inline: node to insert the viewport before

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

    this._bind();
    this._build();
  }

  _bind() {
    this.onWheel = this.onWheel.bind(this);
    this.onPointerDown = this.onPointerDown.bind(this);
    this.onPointerMove = this.onPointerMove.bind(this);
    this.onPointerUp = this.onPointerUp.bind(this);
    this.onKeyDown = this.onKeyDown.bind(this);
    this.onResize = this.onResize.bind(this);
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
      } catch (e) {
        /* svg not laid out yet */
      }
    }
    this.nat = { w: w || 320, h: h || 180 };
  }

  _build() {
    this._measure();

    // The svg renders at its intrinsic size; the stage transform does the rest.
    this.svg.style.width = this.nat.w + "px";
    this.svg.style.height = this.nat.h + "px";
    this.svg.style.maxWidth = "none";
    this.svg.style.display = "block";

    this.stage = el("div", "lookout-stage");
    this.viewport = el(
      "div",
      "lookout-viewport" + (this.fs ? " lookout-viewport--fs" : "")
    );
    this.viewport.tabIndex = 0;
    this.viewport.setAttribute("role", "group");
    this.viewport.setAttribute("aria-label", "Mermaid 다이어그램 — 드래그/스크롤로 이동, Ctrl+스크롤로 확대");

    this.stage.appendChild(this.svg);
    this.viewport.appendChild(this.stage);

    if (this.fs) {
      this.overlay = el("div", "lookout-fs");
      this.overlay.appendChild(this.viewport);
      document.body.appendChild(this.overlay);
    } else {
      // svg has been moved into the stage; place the viewport where it used to be.
      this.parent.classList.add("lookout-host");
      this.parent.insertBefore(this.viewport, this.anchor);
    }

    this._buildToolbar();
    this._attach();

    // Apply the initial view once the viewport has a real width.
    this._scheduleInitialView();
  }

  _buildToolbar() {
    const bar = el("div", "lookout-toolbar" + (this.fs ? " lookout-toolbar--fs" : ""));
    bar.setAttribute("role", "toolbar");

    const mkBtn = (icon, label, handler, extraCls) => {
      const b = el("button", "lookout-btn" + (extraCls ? " " + extraCls : ""));
      b.type = "button";
      b.innerHTML = svgIcon(icon);
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
      document.addEventListener("keydown", this.onKeyDown, true);
    }
  }

  _scheduleInitialView(tries) {
    tries = tries || 0;
    requestAnimationFrame(() => {
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
  // Frame height is based on the diagram's natural height (the 100% basis),
  // so it stays stable whether the content is shown at 100% or fit-to-frame.
  // The frame hugs the diagram's 100% height so a fully visible diagram has no
  // dead space: shorter diagrams shrink the frame, taller ones are capped at
  // 70vh and pan. INLINE_FLOOR only keeps the toolbar usable — a diagram
  // shorter than it simply sits smaller than the frame (acceptable).
  _setInlineHeight() {
    if (this.fs) return;
    const maxH = Math.round(window.innerHeight * 0.7);
    const h = clamp(this.nat.h, INLINE_FLOOR, maxH);
    this.viewport.style.height = Math.round(h) + "px";
  }

  // Default / "100%" view: actual size, anchored top-left.
  actualSize(animate) {
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

  // "Fit to frame": scale so the whole diagram fits, centered.
  fit(animate) {
    this._setInlineHeight();
    const vw = this.viewport.clientWidth;
    const vh = this.viewport.clientHeight;
    if (!vw || !vh) return;

    let s;
    if (this.fs) {
      // contain inside the overlay, never upscale past 1:1
      s = Math.min(vw / this.nat.w, vh / this.nat.h);
    } else {
      // fit to width
      s = vw / this.nat.w;
    }
    s = clamp(Math.min(s, 1), this.minScale, this.maxScale);
    this.scale = s;
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
    let txMin, txMax, tyMin, tyMax;
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
  zoomTo(newScale, cx, cy, animate) {
    newScale = clamp(newScale, this.minScale, this.maxScale);
    const k = newScale / this.scale;
    this.tx = cx - (cx - this.tx) * k;
    this.ty = cy - (cy - this.ty) * k;
    this.scale = newScale;
    this._clampPan();
    this._render(animate);
  }

  zoomBy(factor) {
    this.viewMode = "free";
    this.zoomTo(
      this.scale * factor,
      this.viewport.clientWidth / 2,
      this.viewport.clientHeight / 2,
      true
    );
  }

  /* ---------- input handlers ---------- */
  onWheel(e) {
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

  onPointerDown(e) {
    if (e.button !== 0) return;
    if (e.target.closest && e.target.closest(".lookout-toolbar")) return;
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
    } catch (err) {
      /* ignore */
    }
    this.viewport.addEventListener("pointermove", this.onPointerMove);
    this.viewport.addEventListener("pointerup", this.onPointerUp);
    this.viewport.addEventListener("pointercancel", this.onPointerUp);
  }

  onPointerMove(e) {
    if (!this.drag || e.pointerId !== this.drag.id) return;
    this.viewMode = "free";
    this.tx = this.drag.tx + (e.clientX - this.drag.sx);
    this.ty = this.drag.ty + (e.clientY - this.drag.sy);
    this._clampPan();
    this._render(false);
  }

  onPointerUp(e) {
    if (!this.drag) return;
    this.viewport.classList.remove("is-dragging");
    try {
      this.viewport.releasePointerCapture(this.drag.id);
    } catch (err) {
      /* ignore */
    }
    this.viewport.removeEventListener("pointermove", this.onPointerMove);
    this.viewport.removeEventListener("pointerup", this.onPointerUp);
    this.viewport.removeEventListener("pointercancel", this.onPointerUp);
    this.drag = null;
  }

  onKeyDown(e) {
    // Full-screen Esc is captured at document level.
    if (this.fs && e.key === "Escape") {
      e.preventDefault();
      this.close();
      return;
    }
    if (!this.fs && document.activeElement !== this.viewport) return;

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

  _nudge(dx, dy) {
    this.viewMode = "free";
    this.tx += dx;
    this.ty += dy;
    this._clampPan();
    this._render(true);
  }

  onResize() {
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
  _render(animate) {
    if (animate && !REDUCED_MOTION) {
      this.stage.classList.add("is-animating");
      window.clearTimeout(this._animTimer);
      this._animTimer = window.setTimeout(() => {
        this.stage.classList.remove("is-animating");
      }, 190);
    }
    this.stage.style.transform =
      "translate(" + this.tx + "px," + this.ty + "px) scale(" + this.scale + ")";

    const pct = Math.round(this.scale * 100);
    this.gaugeNum.textContent = pct + "%";

    // Gauge tick fills logarithmically across the zoom range (1:1 sits mid-track).
    const ls = Math.log(this.scale);
    const lmin = Math.log(this.minScale);
    const lmax = Math.log(this.maxScale);
    const frac = clamp((ls - lmin) / (lmax - lmin), 0, 1);
    this.gaugeFill.style.width = (frac * 100).toFixed(1) + "%";

    this.btnOut.disabled = this.scale <= this.minScale + 1e-4;
    this.btnIn.disabled = this.scale >= this.maxScale - 1e-4;
  }

  /* ---------- full-screen ---------- */
  openFullscreen() {
    if (this._fsView) return;
    const clone = this.svg.cloneNode(true);
    clone.style.width = "";
    clone.style.height = "";
    clone.style.maxWidth = "";
    const self = this;
    this._fsView = new DiagramView(clone, {
      fullscreen: true,
      onClose: function () {
        self._fsView = null;
        self.viewport.focus({ preventScroll: true });
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
      document.removeEventListener("keydown", this.onKeyDown, true);
      if (this.overlay) this.overlay.remove();
      return;
    }
    // Restore the inline svg to its original parent so unloading is clean.
    this.svg.style.width = "";
    this.svg.style.height = "";
    this.svg.style.maxWidth = "";
    this.svg.style.display = "";
    if (this.parent && this.viewport.parentElement === this.parent) {
      this.parent.insertBefore(this.svg, this.viewport);
      this.viewport.remove();
      this.parent.classList.remove("lookout-host");
    }
  }
}

/**
 * Wide tables get a single full-screen button (no zoom). Inline, the table
 * keeps its normal horizontal scroll inside our own scroll wrapper so the
 * button can stay pinned to the visible top-right corner. Full screen shows
 * the table in a maximized scroll area where its full width fits far better
 * than in the note's narrow reading column.
 */
class TableView {
  constructor(table, options) {
    options = options || {};
    this.table = table;
    this.parent = options.parent;
    this.anchor = options.anchor;
    this.destroyed = false;
    this.onCloseFs = this.onCloseFs.bind(this);
    this.onFsKeyDown = this.onFsKeyDown.bind(this);
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
    btn.innerHTML = svgIcon("full");
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
    this.overlay = el("div", "lookout-fs lookout-fs--table");

    const scroll = el("div", "lookout-table-fs-scroll");
    const clone = this.table.cloneNode(true);
    clone.classList.add("lookout-table-fs-table");
    scroll.appendChild(clone);
    this.overlay.appendChild(scroll);

    const close = el("button", "lookout-btn lookout-fs-close");
    close.type = "button";
    close.innerHTML = svgIcon("close");
    close.setAttribute("aria-label", "닫기");
    close.title = "닫기 (Esc)";
    close.addEventListener("click", this.onCloseFs);
    this.overlay.appendChild(close);

    // Click on the empty backdrop (not the table) closes the view.
    this.overlay.addEventListener("pointerdown", (e) => {
      if (e.target === this.overlay || e.target === scroll) this.onCloseFs();
    });

    document.body.appendChild(this.overlay);
    document.addEventListener("keydown", this.onFsKeyDown, true);
    close.focus({ preventScroll: true });
  }

  onFsKeyDown(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      this.onCloseFs();
    }
  }

  onCloseFs() {
    if (!this.overlay) return;
    document.removeEventListener("keydown", this.onFsKeyDown, true);
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

module.exports = class LookoutPlugin extends obsidian.Plugin {
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
        for (const node of m.addedNodes) {
          if (node instanceof HTMLElement || node instanceof SVGElement) {
            this.queueScan();
            return;
          }
        }
      }
    });
    this.observer.observe(document.body, { childList: true, subtree: true });

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
    this.scanWithin(document.body);
  }

  scanWithin(root) {
    if (!root || !root.querySelectorAll) return;
    const svgs = root.querySelectorAll('.mermaid svg, svg[id^="mermaid-"]');
    svgs.forEach((svg) => this.process(svg));
    const tables = root.querySelectorAll("table");
    tables.forEach((table) => this.processTable(table));
  }

  process(svg) {
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

  processTable(table) {
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
    const view = [...this.views].find((v) => !v.fs && document.body.contains(v.viewport));
    if (view) {
      view.openFullscreen();
    } else {
      new obsidian.Notice("이 노트에서 Mermaid 다이어그램을 찾지 못했습니다.");
    }
  }
};
