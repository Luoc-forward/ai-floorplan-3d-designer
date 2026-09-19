// 2D 户型编辑器：Canvas 渲染 + 绘图工具 + 缩放平移
import { uid, ROOM_TYPES } from "./store.js";
import { wallLen, distPointSeg, planBounds, planContentBounds, doorSwingSide, syncRoomVerticesToWall } from "./geometry.js";
import { getFurnitureDef } from "./furniture.js";
import { rescalePlan } from "./recognizer.js";

export class View2D {
  constructor(canvas, store, hooks) {
    this.cv = canvas; this.ctx = canvas.getContext("2d");
    this.store = store; this.hooks = hooks || {};
    this.tool = "select";
    this.showBg = true;
    this.sel = null;               // {kind:'wall'|'door'|'window'|'furniture'|'room'|'dim', id}
    this.drag = null;              // 进行中的拖动
    this.pending = null;           // 画墙第一点等
    this.view = { s: 0.06, ox: 80, oy: 80 };
    this.bgImg = null;
    this._hover = null;
    this.bind();
    store.onChange(() => { this.autoFitMaybe(); this.draw(); });
  }

  setSelection(sel) { this.sel = sel; this.hooks.onSelect?.(sel); this.draw(); }

  async setBgImage(dataUrl) {
    if (!dataUrl) { this.bgImg = null; return; }
    this.bgImg = await new Promise(res => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = dataUrl; });
    this.draw();
  }

  autoFitMaybe(force) {
    if (!force && this._fitted) return;
    this.fit(); this._fitted = true;
  }

  fit() {
    this.fitBounds(planContentBounds(this.store.plan), 700);
  }

  fitBounds(b, pad = 900) {
    if (!b || !isFinite(b.x)) return;
    const rect = this.cv.getBoundingClientRect();
    if (rect.width < 80 || rect.height < 80) return false;
    const w = Math.max(1, b.w + pad * 2), h = Math.max(1, b.h + pad * 2);
    this.view.s = Math.max(0.002, Math.min(0.6, Math.min(rect.width / w, rect.height / h)));
    this.view.ox = rect.width / 2 - (b.x + b.w / 2) * this.view.s;
    this.view.oy = rect.height / 2 - (b.y + b.h / 2) * this.view.s;
    this.draw();
    return true;
  }

  fitRoom(room, pad = 650) {
    const xs = room.poly.map(q => q[0]), ys = room.poly.map(q => q[1]);
    const x0 = Math.min(...xs), y0 = Math.min(...ys), x1 = Math.max(...xs), y1 = Math.max(...ys);
    return this.fitBounds({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, pad);
  }

  roomById(id) {
    return this.store.plan.rooms.find(r => r.id === id) || null;
  }

  // ---------- 坐标 ----------
  toWorld(e) {
    const r = this.cv.getBoundingClientRect();
    return { x: (e.clientX - r.left - this.view.ox) / this.view.s,
             y: (e.clientY - r.top - this.view.oy) / this.view.s };
  }

  bind() {
    const cv = this.cv;
    const rr = () => cv.getBoundingClientRect();
    const resize = () => {
      const r = rr();
      const w = Math.max(100, Math.round(r.width));
      const h = Math.max(100, Math.round(r.height));
      if (cv.width === w && cv.height === h) return;
      cv.width = w; cv.height = h;
      // 编辑器从隐藏到显示、或第一次打开方案时，画布可能还是 0 尺寸；此时补做一次全屋适配
      if (!this._fitted) this.autoFitMaybe(true);
      else this.draw();
    };
    new ResizeObserver(resize).observe(cv);
    new ResizeObserver(resize).observe(cv.parentElement);
    requestAnimationFrame(resize);

    cv.addEventListener("wheel", (e) => {
      e.preventDefault();
      const r = rr();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const wx = (mx - this.view.ox) / this.view.s, wy = (my - this.view.oy) / this.view.s;
      const k = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      this.view.s = Math.min(0.6, Math.max(0.005, this.view.s * k));
      this.view.ox = mx - wx * this.view.s; this.view.oy = my - wy * this.view.s;
      this.draw();
    }, { passive: false });

    cv.addEventListener("contextmenu", e => e.preventDefault());
    cv.addEventListener("pointerdown", e => this.onDown(e));
    cv.addEventListener("pointermove", e => this.onMove(e));
    window.addEventListener("pointerup", () => this.onUp());
    window.addEventListener("keydown", e => {
      if (e.key === "Escape") { this.pending = null; this.draw(); }
    });
  }

  setTool(t) {
    this.tool = t;
    this.pending = null;
    this.cv.style.cursor = t === "bgmove" ? "grab" : t === "select" ? "default" : "crosshair";
    this.draw();
  }

  // ---------- 命中测试 ----------
  furnitureLocal(f, wx, wy) {
    // 2D 使用 ctx.rotate(-f.rot)，这里是其逆变换：世界坐标 -> 家具局部坐标
    const dx = wx - f.x, dy = wy - f.y, c = Math.cos(f.rot), st = Math.sin(f.rot);
    return { x: dx * c - dy * st, y: dx * st + dy * c };
  }

  furnitureHandles(f) {
    const def = getFurnitureDef(f.type);
    const hw = def.w * f.sx / 2, hd = def.d * f.sy / 2;
    return [
      { x: -hw, y: -hd, id: "nw" }, { x: 0, y: -hd, id: "n" }, { x: hw, y: -hd, id: "ne" },
      { x: -hw, y: 0, id: "w" }, { x: hw, y: 0, id: "e" },
      { x: -hw, y: hd, id: "sw" }, { x: 0, y: hd, id: "s" }, { x: hw, y: hd, id: "se" },
    ];
  }

  pickFurnitureHandle(wx, wy) {
    if (this.sel?.kind !== "furniture") return null;
    const f = this.store.plan.furniture.find(x => x.id === this.sel.id);
    if (!f) return null;
    const local = this.furnitureLocal(f, wx, wy);
    // 约 14px 的屏幕命中半径，避免选中后在家具内部拖动时误触边缘手柄
    const hitR = Math.max(110, Math.min(260, 14 / Math.max(0.004, this.view.s)));
    for (const h of this.furnitureHandles(f)) {
      if (Math.hypot(local.x - h.x, local.y - h.y) <= hitR) return { kind: "furniture", id: f.id, resizeHandle: h.id };
    }
    return null;
  }

  pick(wx, wy) {
    const p = this.store.plan;
    // 选中家具的缩放手柄优先于拖动本体
    const handle = this.pickFurnitureHandle(wx, wy);
    if (handle) return handle;
    // 家具优先
    for (let i = p.furniture.length - 1; i >= 0; i--) {
      const f = p.furniture[i], def = getFurnitureDef(f.type);
      const local = this.furnitureLocal(f, wx, wy);
      if (Math.abs(local.x) <= def.w * f.sx / 2 && Math.abs(local.y) <= def.d * f.sy / 2)
        return { kind: "furniture", id: f.id };
    }
    // 门窗
    for (const win of p.windows) {
      const w = p.walls.find(x => x.id === win.wallId);
      if (w && this.nearOpening(w, win.off, win.width, wx, wy)) return { kind: "window", id: win.id };
    }
    for (const d of p.doors) {
      const w = p.walls.find(x => x.id === d.wallId);
      if (w && this.nearOpening(w, d.off, d.width, wx, wy)) return { kind: "door", id: d.id };
    }
    // 墙
    let best = null, bd = 400;
    for (const w of p.walls) {
      const r = distPointSeg(wx, wy, w.x1, w.y1, w.x2, w.y2);
      if (r.d < Math.max(w.thick / 2 + 120, 200) && r.d < bd) { bd = r.d; best = { kind: "wall", id: w.id, t: r.t }; }
    }
    if (best) return best;
    // 房间
    for (let i = p.rooms.length - 1; i >= 0; i--) {
      const rm = p.rooms[i];
      if (inside(wx, wy, rm.poly)) return { kind: "room", id: rm.id };
    }
    return null;
  }
  nearOpening(w, off, width, wx, wy) {
    const L = wallLen(w), ux = (w.x2 - w.x1) / L, uy = (w.y2 - w.y1) / L;
    const px = w.x1 + ux * off, py = w.y1 + uy * off;
    const along = (wx - px) * ux + (wy - py) * uy;
    const perp = Math.abs(-(wx - px) * uy + (wy - py) * ux);
    return Math.abs(along) <= width / 2 && perp <= w.thick / 2 + 250;
  }

  onDown(e) {
    if (e.button === 1 || e.button === 2) { this.drag = { pan: true, x: e.clientX, y: e.clientY }; return; }
    const wp = this.toWorld(e);
    const p = this.store.plan;

    if (this.tool === "bgmove") {
      if (!p.imgRect) {
        this.hooks.onNotice?.("当前方案没有可拖动的原始底图");
        return;
      }
      this.drag = {
        bgMove: true,
        start: wp,
        sx: e.clientX,
        sy: e.clientY,
        rect: { ...p.imgRect },
        moved: false,
      };
      this.cv.style.cursor = "grabbing";
      return;
    }

    if (this.tool === "wall") {
      const pt = this.snap(wp.x, wp.y, e.shiftKey);
      if (!this.pending) { this.pending = { x1: pt.x, y1: pt.y }; }
      else {
        this.store.begin();
        p.walls.push({ id: uid("w"), x1: this.pending.x, y1: this.pending.y, x2: pt.x, y2: pt.y, thick: e.altKey ? 200 : 100, load: e.altKey });
        this.store.commit("画墙");
        this.pending = e.shiftKey ? { x1: pt.x, y1: pt.y } : null; // shift 连画
      }
      this.draw(); return;
    }
    if (this.tool === "door" || this.tool === "window") {
      const hit = this.nearestWallSeg(wp.x, wp.y, 600);
      if (hit) {
        this.store.begin();
        if (this.tool === "door")
          p.doors.push({ id: uid("d"), wallId: hit.wall.id, off: hit.off, width: 900, kind: "swing", hingeSide: "left", inward: true, open: 30 });
        else
          p.windows.push({ id: uid("win"), wallId: hit.wall.id, off: hit.off, width: 1500, kind: "normal", sill: 900, height: 1400 });
        this.store.commit("放置" + (this.tool === "door" ? "门" : "窗"));
      }
      return;
    }
    if (this.tool === "erase") {
      const hit = this.pick(wp.x, wp.y);
      if (hit) {
        this.store.begin();
        const arr = { wall: p.walls, door: p.doors, window: p.windows, furniture: p.furniture, room: p.rooms, dim: p.dims }[hit.kind];
        const idx = arr.findIndex(x => x.id === hit.id);
        if (idx >= 0) arr.splice(idx, 1);
        // 删墙时级联删其门窗
        if (hit.kind === "wall") {
          p.doors = p.doors.filter(d => d.wallId !== hit.id);
          p.windows = p.windows.filter(w => w.wallId !== hit.id);
        }
        this.setSelection(null);
        this.store.commit("删除");
      }
      return;
    }
    if (this.tool === "calib") {
      if (!this.pending) { this.pending = { cal: true, x1: wp.x, y1: wp.y }; }
      else {
        const len = Math.hypot(wp.x - this.pending.x1, wp.y - this.pending.y1);
        const mm = parseInt(prompt("这段的实际长度是多少毫米？（如 3600）", "3600"), 10);
        if (mm > 0) {
          this.store.begin();
          rescalePlan(this.store.plan, mm, len);
          this.store.commit("校准尺寸");
          this.fit();
        }
        this.pending = null; this.draw();
      }
      return;
    }
    // select
    const hit = this.pick(wp.x, wp.y);
    this.setSelection(hit);
    if (hit) {
      this.drag = { ...hit, start: wp, moved: false };
      if (hit.kind === "wall") {
        const w = p.walls.find(x => x.id === hit.id);
        const d1 = Math.hypot(wp.x - w.x1, wp.y - w.y1), d2 = Math.hypot(wp.x - w.x2, wp.y - w.y2);
        this.drag.endpoint = d1 < d2 ? 1 : 2;
        this.drag.midpoint = Math.min(d1, d2) > 500;
      }
    }
  }

  onMove(e) {
    const wp = this.toWorld(e);
    if (this.drag?.pan) {
      this.view.ox += e.clientX - this.drag.x; this.view.oy += e.clientY - this.drag.y;
      this.drag.x = e.clientX; this.drag.y = e.clientY; this.draw(); return;
    }
    const p = this.store.plan;
    if (this.drag?.bgMove) {
      const g = this.drag;
      // 底图应跟随鼠标做 1:1 屏幕平移，不受滚轮缩放影响；墙体坐标保持不变
      const dx = e.clientX - g.sx, dy = e.clientY - g.sy;
      if (Math.abs(dx) + Math.abs(dy) > 3) {
        if (!g._begun) { this.store.begin(); g._begun = true; g.moved = true; }
        p.imgRect.x = g.rect.x + dx / this.view.s;
        p.imgRect.y = g.rect.y + dy / this.view.s;
        this.draw();
      }
      return;
    }
    if (this.drag && this.tool === "select") {
      const g = this.drag;
      const dx = wp.x - g.start.x, dy = wp.y - g.start.y;
      if (Math.abs(dx) + Math.abs(dy) > 30) g.moved = true;
      if (!g.moved) return;
      if (!g._begun) { this.store.begin(); g._begun = true; }
      if (g.kind === "furniture") {
        const f = p.furniture.find(x => x.id === g.id);
        if (g.resizeHandle) {
          const def = getFurnitureDef(f.type);
          const local = this.furnitureLocal(f, wp.x, wp.y);
          const clampScale = v => Math.max(0.2, Math.min(5, v));
          if (g.resizeHandle.includes("w") || g.resizeHandle.includes("e"))
            f.sx = clampScale(2 * Math.abs(local.x) / def.w);
          if (g.resizeHandle.includes("n") || g.resizeHandle.includes("s"))
            f.sy = clampScale(2 * Math.abs(local.y) / def.d);
        } else {
          const pt = this.snap(wp.x, wp.y, false, 400);
          f.x = pt.x; f.y = pt.y;
        }
      } else if (g.kind === "wall") {
        const w = p.walls.find(x => x.id === g.id);
        const oldWall = { ...w };
        const pt = this.snap(wp.x, wp.y, e.shiftKey);
        if (g.midpoint) { w.x1 += dx; w.y1 += dy; w.x2 += dx; w.y2 += dy; g.start = wp; }
        else if (g.endpoint === 1) { w.x1 = pt.x; w.y1 = pt.y; }
        else { w.x2 = pt.x; w.y2 = pt.y; }
        syncRoomVerticesToWall(p, oldWall, w);
      } else if (g.kind === "door" || g.kind === "window") {
        const arr = g.kind === "door" ? p.doors : p.windows;
        const o = arr.find(x => x.id === g.id);
        const w = p.walls.find(x => x.id === o.wallId);
        if (w) {
          const hit = this.nearestWallSeg(wp.x, wp.y, 99999, w);
          o.off = Math.max(o.width / 2, Math.min(wallLen(w) - o.width / 2, hit.off));
        }
      }
      this.draw();
      return;
    }
    this._moveWp = wp;
    if (this.tool === "select" && !this.drag) {
      const h = this.pickFurnitureHandle(wp.x, wp.y);
      const cursorMap = { n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize", ne: "nwse-resize", sw: "nwse-resize", nw: "nesw-resize", se: "nesw-resize" };
      this.cv.style.cursor = h ? (cursorMap[h.resizeHandle] || "pointer") : "default";
    }
    this.draw();
  }

  onUp() {
    if (this.drag?._begun) this.store.commit(this.drag.bgMove ? "拖动底图" : "拖动");
    if (this.drag?.bgMove) this.cv.style.cursor = "grab";
    this.drag = null;
  }

  nearestWallSeg(x, y, maxD, only) {
    const p = this.store.plan;
    let best = null;
    for (const w of p.walls) {
      if (only && w.id !== only.id) continue;
      const r = distPointSeg(x, y, w.x1, w.y1, w.x2, w.y2);
      if (r.d < maxD) { maxD = r.d; best = { wall: w, off: r.t * wallLen(w) }; }
    }
    return best;
  }

  snap(x, y, ortho, tol) {
    const p = this.store.plan; const T = tol ?? 350;
    let rx = x, ry = y;
    for (const w of p.walls) {
      for (const [ex, ey] of [[w.x1, w.y1], [w.x2, w.y2]]) {
        if (Math.hypot(ex - x, ey - y) < T) { rx = ex; ry = ey; }
      }
    }
    if (this.pending && !this.pending.cal) {
      const dx = x - this.pending.x1, dy = y - this.pending.y1;
      if (ortho || Math.abs(dx) < T) ry = this.pending.y1;
      if (ortho || Math.abs(dy) < T) rx = this.pending.x1;
    }
    return { x: rx, y: ry };
  }

  // ---------- 渲染 ----------
  draw() {
    const ctx = this.ctx, p = this.store.plan;
    const W = this.cv.width, H = this.cv.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#f4f5f7"; ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.translate(this.view.ox, this.view.oy);
    ctx.scale(this.view.s, this.view.s);
    ctx.lineJoin = "round";

    // 原图
    if (this.showBg && p.image && this.bgImg && p.imgRect) {
      ctx.globalAlpha = 0.55;
      ctx.drawImage(this.bgImg, p.imgRect.x, p.imgRect.y, p.imgRect.w, p.imgRect.h);
      ctx.globalAlpha = 1;
    }
    // 房间
    for (const r of p.rooms) {
      ctx.beginPath();
      r.poly.forEach((q, i) => i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]));
      ctx.closePath();
      ctx.fillStyle = r.floorColor || "#e7d7ba";
      ctx.globalAlpha = 0.35; ctx.fill(); ctx.globalAlpha = 1;
      if (this.sel?.kind === "room" && this.sel.id === r.id) {
        ctx.strokeStyle = "#4f8cff"; ctx.lineWidth = 80; ctx.stroke();
      }
      const cx = r.poly.reduce((s, q) => s + q[0], 0) / r.poly.length;
      const cy = r.poly.reduce((s, q) => s + q[1], 0) / r.poly.length;
      ctx.fillStyle = "#333";
      ctx.font = "600 360px 'Microsoft YaHei'";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(r.name || ROOM_TYPES[r.type] || "", cx, cy - 180);
      if (r.areaM2) {
        ctx.font = "260px 'Microsoft YaHei'"; ctx.fillStyle = "#888";
        ctx.fillText(r.areaM2.toFixed(1) + "㎡", cx, cy + 220);
      }
    }

    // 墙体（含门窗洞）
    for (const w of p.walls) this.drawWall(w);
    // 门
    for (const d of p.doors) this.drawDoor(d);
    // 窗
    for (const win of p.windows) this.drawWindow(win);

    // 家具
    for (const f of p.furniture) this.drawFurniture(f);

    // 尺寸标注
    for (const dim of p.dims) this.drawDim(dim);

    // 画墙预览
    if (this.pending && !this.pending.cal && this._moveWp) {
      const pt = this.snap(this._moveWp.x, this._moveWp.y, false);
      ctx.strokeStyle = "#4f8cff"; ctx.lineWidth = 60; ctx.setLineDash([120, 120]);
      ctx.beginPath(); ctx.moveTo(this.pending.x1, this.pending.y1); ctx.lineTo(pt.x, pt.y); ctx.stroke();
      ctx.setLineDash([]);
    }
    if (this.pending?.cal && this._moveWp) {
      ctx.strokeStyle = "#e0457a"; ctx.lineWidth = 50;
      ctx.beginPath(); ctx.moveTo(this.pending.x1, this.pending.y1); ctx.lineTo(this._moveWp.x, this._moveWp.y); ctx.stroke();
    }
    ctx.restore();

    // 比例尺信息
    const info = document.getElementById("scaleInfo");
    if (info) info.textContent = `比例：1px≈${(1 / this.view.s).toFixed(0)}mm（屏幕）｜来源：${p.scaleSource || "—"}｜墙高 ${p.wallHeight}mm`;
  }

  wallFrame(w) {
    const L = wallLen(w), ux = (w.x2 - w.x1) / L, uy = (w.y2 - w.y1) / L;
    const nx = -uy, ny = ux, h = w.thick / 2;
    return {
      L, ux, uy,
      rect: (a, b) => [
        [w.x1 + ux * a + nx * h, w.y1 + uy * a + ny * h],
        [w.x1 + ux * b + nx * h, w.y1 + uy * b + ny * h],
        [w.x1 + ux * b - nx * h, w.y1 + uy * b - ny * h],
        [w.x1 + ux * a - nx * h, w.y1 + uy * a - ny * h],
      ],
    };
  }

  gapsOn(w) {
    const p = this.store.plan;
    const gaps = [];
    for (const d of p.doors) if (d.wallId === w.id) gaps.push({ a: d.off - d.width / 2, b: d.off + d.width / 2 });
    for (const win of p.windows) if (win.wallId === w.id) gaps.push({ a: win.off - win.width / 2, b: win.off + win.width / 2 });
    gaps.sort((a, b) => a.a - b.a);
    return gaps;
  }

  poly(pts, fill, stroke, lw) {
    const ctx = this.ctx;
    ctx.beginPath(); pts.forEach((q, i) => i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]));
    ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw || 20; ctx.stroke(); }
  }

  drawWall(w) {
    const { L, rect } = this.wallFrame(w);
    const gaps = this.gapsOn(w);
    const fill = w.load ? "#262a31" : "#3a3f48";
    let cursor = 0;
    const segs = [];
    for (const g of gaps) {
      if (g.a > cursor) segs.push([cursor, Math.min(g.a, L)]);
      cursor = Math.max(cursor, g.b);
    }
    segs.push([cursor, L]);
    for (const [a, b] of segs) if (b - a > 5) this.poly(rect(a, b), fill, null);
    if (this.sel?.kind === "wall" && this.sel.id === w.id) {
      const [A, B, C, D] = rect(0, L);
      this.ctx.strokeStyle = "#4f8cff"; this.ctx.lineWidth = 50;
      this.ctx.beginPath(); [A, B, C, D].forEach((q, i) => i ? this.ctx.lineTo(q[0], q[1]) : this.ctx.moveTo(q[0], q[1]));
      this.ctx.closePath(); this.ctx.stroke();
    }
  }

  drawDoor(d) {
    const ctx = this.ctx, p = this.store.plan;
    const w = p.walls.find(x => x.id === d.wallId);
    if (!w) return;
    const L = wallLen(w), ux = (w.x2 - w.x1) / L, uy = (w.y2 - w.y1) / L, nx = -uy, ny = ux;
    const cx = w.x1 + ux * d.off, cy = w.y1 + uy * d.off;
    if (d.kind === "sliding") {
      const a = d.off - d.width / 2, b = d.off + d.width / 2, mid = (a + b) / 2;
      const ln = (s, e, off) => this.ctxLine(
        w.x1 + ux * s + nx * off, w.y1 + uy * s + ny * off,
        w.x1 + ux * e + nx * off, w.y1 + uy * e + ny * off, "#1c5fc0", 26);
      ln(a, mid, 40); ln(mid, b, -40);
      return;
    }
    // 与 3D 一致：gs=合页端符号，s=开阔侧符号
    const gs = d.hingeSide === "right" ? -1 : 1;
    const s = doorSwingSide(p, w, d);
    const hx = cx - gs * ux * d.width / 2, hy = cy - gs * uy * d.width / 2;
    const alpha = (d.open ?? 30) * Math.PI / 180;
    const ex = hx + d.width * (gs * ux * Math.cos(alpha) + s * nx * Math.sin(alpha));
    const ey = hy + d.width * (gs * uy * Math.cos(alpha) + s * ny * Math.sin(alpha));
    this.ctxLine(hx, hy, ex, ey, "#1c5fc0", 34);
    // 门弧：从关闭端扫到开启端
    const a0 = Math.atan2(gs * uy, gs * ux);
    const a1 = Math.atan2(gs * uy * Math.cos(alpha) + s * ny * Math.sin(alpha),
                          gs * ux * Math.cos(alpha) + s * nx * Math.sin(alpha));
    ctx.strokeStyle = "#1c5fc0"; ctx.lineWidth = 16;
    ctx.beginPath();
    if (s * gs > 0) ctx.arc(hx, hy, d.width, Math.min(a0, a1), Math.max(a0, a1), false);
    else ctx.arc(hx, hy, d.width, Math.min(a0, a1), Math.max(a0, a1), true);
    ctx.stroke();
    if (this.sel?.kind === "door" && this.sel.id === d.id) {
      ctx.strokeStyle = "#ff9f0a"; ctx.lineWidth = 40;
      ctx.beginPath(); ctx.arc(cx, cy, d.width / 2 + 120, 0, Math.PI * 2); ctx.stroke();
    }
  }

  drawWindow(win) {
    const p = this.store.plan;
    const ww = p.walls.find(x => x.id === win.wallId);
    if (!ww) return;
    const { L, ux, uy } = this.wallFrame(ww);
    const nx = -uy, ny = ux, h = ww.thick / 2;
    const a = win.off - win.width / 2, b = win.off + win.width / 2;
    // 白洞
    this.poly(this.wallFrame(ww).rect(a, b), "#f4f5f7", null);
    if (win.kind === "bay") {
      // 飘窗：向外凸出的矩形 + 玻璃线
      const out = 450;
      const pts = [
        [ww.x1 + ux * a - nx * h, ww.y1 + uy * a - ny * h],
        [ww.x1 + ux * b - nx * h, ww.y1 + uy * b - ny * h],
        [ww.x1 + ux * b - nx * (h + out), ww.y1 + uy * b - ny * (h + out)],
        [ww.x1 + ux * a - nx * (h + out), ww.y1 + uy * a - ny * (h + out)],
      ];
      this.poly(pts, "rgba(120,180,230,.25)", "#3d7fc4", 22);
    }
    // 三条/四条玻璃线
    for (const off of [-h, -h / 3, h / 3, h]) {
      this.ctxLine(
        ww.x1 + ux * a + nx * off, ww.y1 + uy * a + ny * off,
        ww.x1 + ux * b + nx * off, ww.y1 + uy * b + ny * off, "#3d7fc4", win.kind === "bay" ? 14 : 12);
    }
    if (this.sel?.kind === "window" && this.sel.id === win.id) {
      const cxA = ww.x1 + ux * ((a + b) / 2), cyA = ww.y1 + uy * ((a + b) / 2);
      this.ctx.strokeStyle = "#ff9f0a"; this.ctx.lineWidth = 40;
      this.ctx.beginPath(); this.ctx.arc(cxA, cyA, 220, 0, Math.PI * 2); this.ctx.stroke();
    }
  }

  drawFurniture(f) {
    const ctx = this.ctx, def = getFurnitureDef(f.type);
    ctx.save();
    ctx.translate(f.x, f.y); ctx.rotate(-f.rot);
    const w = def.w * f.sx, d = def.d * f.sy;
    ctx.fillStyle = f.color || def.color;
    ctx.globalAlpha = 0.9;
    ctx.fillRect(-w / 2, -d / 2, w, d);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = "rgba(0,0,0,.35)"; ctx.lineWidth = 14; ctx.strokeRect(-w / 2, -d / 2, w, d);
    ctx.fillStyle = "#222"; ctx.font = `${Math.min(360, d * 0.5)}px serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(def.ico, 0, 0);
    ctx.restore();
    if (this.sel?.kind === "furniture" && this.sel.id === f.id) {
      ctx.save(); ctx.translate(f.x, f.y); ctx.rotate(-f.rot);
      ctx.strokeStyle = "#4f8cff"; ctx.lineWidth = 44;
      ctx.strokeRect(-w / 2 - 60, -d / 2 - 60, w + 120, d + 120);
      const r = Math.max(70, 9 / Math.max(0.004, this.view.s));
      for (const h of this.furnitureHandles(f)) {
        ctx.beginPath(); ctx.arc(h.x, h.y, r, 0, Math.PI * 2);
        ctx.fillStyle = "#ffffff"; ctx.fill();
        ctx.strokeStyle = "#1c6fe8"; ctx.lineWidth = Math.max(12, 2 / this.view.s); ctx.stroke();
      }
      ctx.fillStyle = "#1c5fc0";
      ctx.font = `${Math.max(180, 24 / this.view.s)}px 'Microsoft YaHei'`;
      ctx.textAlign = "center"; ctx.textBaseline = "top";
      ctx.fillText(`${Math.round(def.w * f.sx)} × ${Math.round(def.d * f.sy)} mm`, 0, d / 2 + 100);
      ctx.restore();
    }
  }

  drawDim(dim) {
    const ctx = this.ctx;
    ctx.strokeStyle = "#b0387a"; ctx.lineWidth = 14;
    ctx.beginPath(); ctx.moveTo(dim.x1, dim.y1); ctx.lineTo(dim.x2, dim.y2); ctx.stroke();
    const ang = Math.atan2(dim.y2 - dim.y1, dim.x2 - dim.x1);
    for (const [x, y, a] of [[dim.x1, dim.y1, ang], [dim.x2, dim.y2, ang]]) {
      ctx.beginPath();
      ctx.moveTo(x - 120 * Math.cos(a - 0.35), y - 120 * Math.sin(a - 0.35));
      ctx.lineTo(x + 120 * Math.cos(a - 0.35), y + 120 * Math.sin(a - 0.35));
      ctx.stroke();
    }
    const mx = (dim.x1 + dim.x2) / 2, my = (dim.y1 + dim.y2) / 2;
    ctx.save();
    ctx.translate(mx, my - 160);
    if (Math.abs(ang) > Math.PI / 3) ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = "#b0387a"; ctx.font = "300px 'Microsoft YaHei'";
    ctx.textAlign = "center";
    ctx.fillText(dim.text + "mm", 0, 0);
    ctx.restore();
  }

  ctxLine(x1, y1, x2, y2, color, lw) {
    const c = this.ctx;
    c.strokeStyle = color; c.lineWidth = lw;
    c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke();
  }

  // 导出白底户型图到离屏 canvas（供 PNG/SVG 参考）
  exportCanvas(withBg, scale = 0.15) {
    const b = planContentBounds(this.store.plan, { image: withBg });
    const pad = 1500;
    const cv = document.createElement("canvas");
    cv.width = Math.round((b.w + pad * 2) * scale);
    cv.height = Math.round((b.h + pad * 2) * scale);
    return new View2DExport(this, cv, { x: b.x - pad, y: b.y - pad, s: scale }).render(withBg);
  }
}

function inside(x, y, poly) {
  let inP = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-9) + xi)) inP = !inP;
  }
  return inP;
}

// 离屏导出：复制当前 View2D 的渲染，替换变换与画布
class View2DExport {
  constructor(view, cv, t) {
    this.v = view; this.cv = cv; this.ctx = cv.getContext("2d"); this.t = t;
  }
  render(withBg) {
    const v = this.v, ctx = this.ctx, p = v.store.plan;
    ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, this.cv.width, this.cv.height);
    // 借用 v 的绘制：临时替换 canvas/ctx/view
    const oc = v.cv, oo = v.ctx, ov = v.view, ob = v.showBg;
    v.cv = this.cv; v.ctx = ctx; v.view = { s: this.t.s, ox: -this.t.x * this.t.s, oy: -this.t.y * this.t.s };
    v.showBg = withBg;
    v.draw();
    v.cv = oc; v.ctx = oo; v.view = ov; v.showBg = ob;
    return this.cv;
  }
}