// 几何工具：AI 归一化结果 -> 毫米户型，吸附/直角化/挂接/比例尺
export const TAU = Math.PI * 2;

export const dist = (x1, y1, x2, y2) => Math.hypot(x2 - x1, y2 - y1);
export const wallLen = (w) => Math.hypot(w.x2 - w.x1, w.y2 - w.y1);

export function distPointSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const L2 = dx * dx + dy * dy;
  if (!L2) return { d: dist(px, py, x1, y1), t: 0, cx: x1, cy: y1 };
  let t = ((px - x1) * dx + (py - y1) * dy) / L2;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx, cy = y1 + t * dy;
  return { d: Math.hypot(px - cx, py - cy), t, cx, cy };
}

export function nearestWall(plan, x, y, maxD = Infinity) {
  let best = null;
  for (const w of plan.walls) {
    const r = distPointSeg(x, y, w.x1, w.y1, w.x2, w.y2);
    if (r.d < maxD) { maxD = r.d; best = { wall: w, off: r.t * wallLen(w), t: r.t }; }
  }
  return best;
}

// 门/窗重新挂接到最近墙，重算 off
export function attachOpenings(plan) {
  for (const d of plan.doors) {
    const x = d.at?.[0] ?? d.x, y = d.at?.[1] ?? d.y;
    if (x == null) continue;
    const hit = nearestWall(plan, x, y, 500);
    if (hit) { d.wallId = hit.wall.id; d.off = hit.off; }
    delete d.at; delete d.x; delete d.y;
  }
  for (const win of plan.windows) {
    if (!win.from) continue;
    const mx = (win.from[0] + win.to[0]) / 2, my = (win.from[1] + win.to[1]) / 2;
    const hit = nearestWall(plan, mx, my, 500);
    if (hit) {
      win.wallId = hit.wall.id; win.off = hit.off;
      const span = dist(win.from[0], win.from[1], win.to[0], win.to[1]);
      if (span > 100) win.width = span;
    }
    delete win.from; delete win.to;
  }
}

// 正交轴网重建：所有墙强制归水平/垂直；所有 x/y 坐标各用一套统一槽位聚类，
// 水平墙端点与垂直墙共用同一槽，因此交点必然完全重合（零缝隙）；再合并共线碎段。
export function cleanupWalls(plan, tol = 350) {
  const ws = plan.walls;
  if (!ws.length) return;
  const isH = (w) => Math.abs(w.x2 - w.x1) >= Math.abs(w.y2 - w.y1);
  const allX = [], allY = [];
  ws.forEach(w => { allX.push(w.x1, w.x2); allY.push(w.y1, w.y2); });
  // 统一坐标槽（所有墙端点 + 墙中点都参与，使轴线也落槽）
  ws.forEach(w => { if (isH(w)) allY.push((w.y1 + w.y2) / 2); else allX.push((w.x1 + w.x2) / 2); });
  const xSlots = cluster1d(allX, tol), ySlots = cluster1d(allY, tol);
  const snap = (slots, v) => { let best = v, bd = tol; for (const z of slots) if (Math.abs(z - v) < bd) { bd = Math.abs(z - v); best = z; } return best; };

  const norm = [];
  for (const w of ws) {
    if (isH(w)) {
      const y = snap(ySlots, (w.y1 + w.y2) / 2);
      const x1 = snap(xSlots, w.x1), x2 = snap(xSlots, w.x2);
      if (Math.abs(x2 - x1) < 250) continue;
      norm.push({ ...w, y1: y, y2: y, x1: Math.min(x1, x2), x2: Math.max(x1, x2) });
    } else {
      const x = snap(xSlots, (w.x1 + w.x2) / 2);
      const y1 = snap(ySlots, w.y1), y2 = snap(ySlots, w.y2);
      if (Math.abs(y2 - y1) < 250) continue;
      norm.push({ ...w, x1: x, x2: x, y1: Math.min(y1, y2), y2: Math.max(y1, y2) });
    }
  }
  plan.walls = mergeCollinear(norm, tol);
}

// 一维贪心聚类（相近归并，取均值）
function cluster1d(vals, tol) {
  const sorted = [...vals].sort((a, b) => a - b);
  const out = [];
  for (const v of sorted) {
    const c = out[out.length - 1];
    if (c && Math.abs(v - c[c.length - 1]) <= tol) c.push(v);
    else out.push([v]);
  }
  return out.map(c => c.reduce((a, b) => a + b, 0) / c.length);
}

// 合并同一直线上、间隔<=tol 的碎墙段，保留较厚/承重属性
function mergeCollinear(ws, tol) {
  const groups = new Map();
  const key = (axis, line) => axis + ":" + Math.round(line);
  for (const w of ws) {
    const h = Math.abs(w.x2 - w.x1) >= Math.abs(w.y2 - w.y1);
    const axis = h ? "h" : "v", line = h ? w.y1 : w.x1;
    let placed = false;
    for (const g of groups.keys()) {
      const [ga, gl] = g.split(":");
      if (ga === axis && Math.abs(+gl - line) <= tol) { groups.get(g).push(w); placed = true; break; }
    }
    if (!placed) groups.set(key(axis, line), [w]);
  }
  const out = [];
  for (const [, arr] of groups) {
    const h = Math.abs(arr[0].x2 - arr[0].x1) >= Math.abs(arr[0].y2 - arr[0].y1);
    arr.sort((a, b) => (h ? a.x1 - b.x1 : a.y1 - b.y1));
    let cur = null;
    for (const w of arr) {
      const s = h ? w.x1 : w.y1, e = h ? w.x2 : w.y2;
      if (!cur) cur = { s, e, ids: [w], thick: w.thick, load: w.load };
      else if (s <= cur.e + tol) { cur.e = Math.max(cur.e, e); cur.ids.push(w); cur.thick = Math.max(cur.thick, w.thick); cur.load = cur.load || w.load; }
      else { out.push(emit(cur, h)); cur = { s, e, ids: [w], thick: w.thick, load: w.load }; }
    }
    if (cur) out.push(emit(cur, h));
  }
  return out;
}
function emit(cur, h) {
  const base = cur.ids[0];
  return h
    ? { ...base, x1: cur.s, x2: cur.e, y1: base.y1, y2: base.y1, thick: cur.thick, load: cur.load }
    : { ...base, y1: cur.s, y2: cur.e, x1: base.x1, x2: base.x1, thick: cur.thick, load: cur.load };
}

function endpoint(w, e) { return e === 1 ? { x: w.x1, y: w.y1 } : { x: w.x2, y: w.y2 }; }
function setEndpoint(w, e, x, y) { if (e === 1) { w.x1 = x; w.y1 = y; } else { w.x2 = x; w.y2 = y; } }


// 房间轴对齐包围盒
export function roomBounds(poly) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of poly) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y);
    x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, x1, y1 };
}

export function refreshRoomAreas(plan) {
  for (const r of plan.rooms || []) r.areaM2 = Math.round(roomArea(r.poly) * 10) / 10;
}

// 拖动墙体后，把贴近旧墙的房间顶点映射到新墙位置：
// - 平移整段墙：共墙房间的边一起平移；
// - 拉墙端点：沿墙方向线性拉伸，垂直距离保持不变。
export function syncRoomVerticesToWall(plan, oldWall, wall) {
  const ax = oldWall.x1, ay = oldWall.y1, bx = oldWall.x2, by = oldWall.y2;
  const nax = wall.x1, nay = wall.y1, nbx = wall.x2, nby = wall.y2;
  const oldLen2 = (bx - ax) ** 2 + (by - ay) ** 2;
  if (oldLen2 < 1e-6) return;

  const oldLen = Math.sqrt(oldLen2);
  const newLen = Math.hypot(nbx - nax, nby - nay) || 1;
  const move = Math.hypot(nax - ax, nay - ay, nbx - bx, nby - by);
  const radius = Math.max(320, oldWall.thick / 2 + 220 + move * 0.6);

  for (const room of plan.rooms || []) {
    let changed = false;
    room.poly = room.poly.map(([x, y]) => {
      const vx = x - ax, vy = y - ay;
      const t = (vx * (bx - ax) + vy * (by - ay)) / oldLen2;
      if (t < -0.08 || t > 1.08) return [x, y];

      // 旧墙局部坐标：along=沿墙参数，perp=带符号法线距离
      const perp = (vx * (by - ay) - vy * (bx - ax)) / oldLen;
      if (Math.abs(perp) > radius) return [x, y];

      const tc = Math.max(0, Math.min(1, t));
      const nux = (nbx - nax) / newLen, nuy = (nby - nay) / newLen;
      const nnx = -nuy, nny = nux;
      const nx = nax + tc * (nbx - nax) + nnx * perp;
      const ny = nay + tc * (nby - nay) + nny * perp;
      changed = true;
      return [nx, ny];
    });
    if (changed) room.areaM2 = Math.round(roomArea(room.poly) * 10) / 10;
  }
}

// 由尺寸标注解算比例尺（每归一化单位 = 多少毫米），水平/垂直分别取中位数
export function solveScale(raw) {
  const valsX = [], valsY = [];
  for (const d of raw.dimensions || []) {
    const mm = parseFloat(String(d.text || "").replace(/[^\d.]/g, ""));
    if (!mm || !d.from || !d.to) continue;
    const du = dist(d.from[0], d.from[1], d.to[0], d.to[1]);
    if (du < 20) continue;
    const ang = Math.abs(Math.atan2(d.to[1] - d.from[1], d.to[0] - d.from[0]));
    const mmPerUnit = mm / du;
    if (ang < Math.PI / 6) valsX.push(mmPerUnit);
    else if (ang > Math.PI / 3) valsY.push(mmPerUnit);
  }
  const med = (a) => { if (!a.length) return null; a.sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
  let sx = med(valsX), sy = med(valsY);
  if (!sx) sx = sy;
  if (!sy) sy = sx;
  return { sx, sy };
}

export function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-9) + xi)) inside = !inside;
  }
  return inside;
}

export function roomArea(poly) {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    a += (poly[j][0] + poly[i][0]) * (poly[j][1] - poly[i][1]);
  }
  return Math.abs(a) / 2 / 1e6; // m²
}

// 2D 可视内容包围盒：除墙体外，也包含房间面、尺寸标注和家具
// image=true 时额外纳入原始底图，供“叠加原图”导出使用，避免移动后的底图被裁切
export function planContentBounds(plan, opt = {}) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const upd = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    x0 = Math.min(x0, x); y0 = Math.min(y0, y);
    x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  };
  for (const w of plan.walls || []) { upd(w.x1, w.y1); upd(w.x2, w.y2); }
  for (const r of plan.rooms || []) for (const q of r.poly || []) upd(q[0], q[1]);
  for (const d of plan.dims || []) { upd(d.x1, d.y1); upd(d.x2, d.y2); }
  for (const f of plan.furniture || []) upd(f.x, f.y);
  if (opt.image && plan.imgRect) {
    const r = plan.imgRect;
    upd(r.x, r.y); upd(r.x + r.w, r.y); upd(r.x, r.y + r.h); upd(r.x + r.w, r.y + r.h);
  }
  if (!isFinite(x0)) return { x: 0, y: 0, w: 9000, h: 6000 };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// 3D/物理户型包围盒：不把可单独拖动的原始底图算入相机范围
export function planBounds(plan) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const upd = (x, y) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
  for (const w of plan.walls) { upd(w.x1, w.y1); upd(w.x2, w.y2); }
  for (const f of plan.furniture || []) upd(f.x, f.y);
  if (!isFinite(x0)) return { x: 0, y: 0, w: 9000, h: 6000 };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
// 找包含点的最小房间
export function roomAt(plan, x, y) {
  let best = null, ba = Infinity;
  for (const r of plan.rooms || []) {
    if (pointInPoly(x, y, r.poly)) {
      const a = roomArea(r.poly);
      if (a < ba) { ba = a; best = r; }
    }
  }
  return best;
}

// 门应向哪一侧开：+1 = 墙法线 n=(-uy,ux) 侧，-1 = 反侧
export function doorSwingSide(plan, wall, door) {
  const L = wallLen(wall), ux = (wall.x2 - wall.x1) / L, uy = (wall.y2 - wall.y1) / L;
  const nx = -uy, ny = ux;
  const mx = wall.x1 + ux * door.off, my = wall.y1 + uy * door.off;
  const rP = roomAt(plan, mx + nx * 600, my + ny * 600);
  const rM = roomAt(plan, mx - nx * 600, my - ny * 600);
  if (rP && !rM) return 1;
  if (rM && !rP) return -1;
  if (rP && rM) return roomArea(rP.poly) <= roomArea(rM.poly) ? 1 : -1;
  return 1;
}

// 房间多边形顶点吸附到最近墙线，让地面边界贴合墙体
export function snapRoomsToWalls(plan, tol = 350) {
  for (const r of plan.rooms || []) {
    r.poly = r.poly.map(([x, y]) => {
      let best = null, bd = tol;
      for (const w of plan.walls) {
        const rr = distPointSeg(x, y, w.x1, w.y1, w.x2, w.y2);
        if (rr.d < bd) { bd = rr.d; best = [rr.cx, rr.cy]; }
      }
      return best || [x, y];
    });
    r.areaM2 = Math.round(roomArea(r.poly) * 10) / 10;
  }
}
