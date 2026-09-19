// 识别服务：上传图片 -> 后端代理豆包 -> 归一化结果清洗为毫米户型
import { uid } from "./store.js";
import { solveScale, cleanupWalls, nearestWall, roomArea, snapRoomsToWalls, pointInPoly } from "./geometry.js";

export async function recognize(dataUrl, thinking, onStage) {
  onStage?.("正在调用 AI 视觉模型…");
  const resp = await fetch("/api/recognize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: dataUrl, thinking: !!thinking }),
  });
  const j = await resp.json();
  if (!resp.ok) throw new Error(j.error || "识别失败");
  return { raw: j.raw, elapsed: j.elapsed };
}

const ROOM_CN = {
  living_room: "客厅", dining_room: "餐厅", bedroom: "卧室", master_bedroom: "主卧",
  kitchen: "厨房", bathroom: "卫生间", balcony: "阳台", study: "书房", other: "房间",
};
const FLOOR_COLORS = ["#e7d7ba", "#e2cfac", "#e6d5b6", "#eae3d6", "#e8e6e1", "#e4dccb"];

// 把 AI 返回的 0~1000 归一化结构转成内部毫米 plan
export function aiToPlan(raw, imageW, imageH, imageDataUrl) {
  let { sx, sy } = solveScale(raw);
  let scaleSource = "尺寸标注";
  if (!sx) {
    sx = sy = 9; scaleSource = "默认9m估算";
  }

  const plan = {
    name: "AI 识别户型",
    image: imageDataUrl || null, imageW, imageH,
    imgRect: { x: 0, y: 0, w: 1000 * sx, h: 1000 * sy },
    imgRect0: { x: 0, y: 0, w: 1000 * sx, h: 1000 * sy },
    pxPerMm: 1 / ((sx + sy) / 2), scaleSource,
    north: raw.northDirectionDeg || 0,
    wallHeight: 2800, wallColor: "#ffffff", ceilColor: "#ffffff",
    walls: [], doors: [], windows: [], rooms: [], dims: [], furniture: [],
  };

  for (const w of raw.walls || []) {
    if (!w.from || !w.to || w.from.length < 2 || w.to.length < 2) continue;
    plan.walls.push({
      id: w.id || uid("w"),
      x1: w.from[0] * sx, y1: w.from[1] * sy,
      x2: w.to[0] * sx, y2: w.to[1] * sy,
      thick: w.thicknessMm === 100 ? 100 : 200,
      load: w.loadBearing !== false,
    });
  }
  cleanupWalls(plan);

  for (const d of raw.doors || []) {
    if (!d.at || d.at.length < 2) continue;
    const x = d.at[0] * sx, y = d.at[1] * sy;
    const hit = nearestWall(plan, x, y, 500);
    plan.doors.push({
      id: d.id || uid("d"),
      wallId: hit?.wall.id || "",
      off: hit?.off ?? 0,
      width: d.widthMm || 900,
      kind: d.kind || "swing",
      hingeSide: d.hingeSide || "left",
      inward: d.opensInward !== false,
      open: 30,
    });
  }

  for (const win of raw.windows || []) {
    if (!win.from || !win.to) continue;
    const mx = (win.from[0] + win.to[0]) * sx / 2;
    const my = (win.from[1] + win.to[1]) * sy / 2;
    const hit = nearestWall(plan, mx, my, 500);
    const span = Math.hypot((win.to[0] - win.from[0]) * sx, (win.to[1] - win.from[1]) * sy);
    plan.windows.push({
      id: win.id || uid("win"),
      wallId: hit?.wall.id || "",
      off: hit?.off ?? 0,
      width: Math.max(600, span || 1500),
      kind: win.kind || "normal",
      sill: win.sillMm || 900,
      height: 1400,
    });
  }

  (raw.rooms || []).forEach((r, i) => {
    if (!r.polygon || r.polygon.length < 3) return;
    const poly = r.polygon.map(p => [p[0] * sx, p[1] * sy]);
    plan.rooms.push({
      id: r.id || uid("r"),
      name: r.name || ROOM_CN[r.type] || "房间",
      type: r.type || "other",
      poly,
      floorColor: FLOOR_COLORS[i % FLOOR_COLORS.length],
      areaM2: Math.round(roomArea(poly) * 10) / 10,
    });
  });

  for (const dim of raw.dimensions || []) {
    if (!dim.from || !dim.to) continue;
    plan.dims.push({
      id: uid("dim"), text: String(dim.text),
      x1: dim.from[0] * sx, y1: dim.from[1] * sy,
      x2: dim.to[0] * sx, y2: dim.to[1] * sy,
    });
  }

  mergeOpenRooms(plan);
  snapRoomsToWalls(plan);
  plan.aiNotes = raw.notes || "";
  return plan;
}

export function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}

export function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}

// 手动校准：把当前“测得的世界长度 measuredMm”修正为真实 knownMm，全屋几何位置等比缩放。
// 只缩放位置类坐标；墙厚、门窗宽高/窗台、层高、家具尺寸等真实物理量不动。
export function rescalePlan(plan, knownMm, measuredMm) {
  const k = knownMm / Math.max(1, measuredMm);
  const K = (o, ...ks) => ks.forEach(key => { if (o[key] != null) o[key] *= k; });
  for (const w of plan.walls) K(w, "x1", "y1", "x2", "y2");
  for (const d of plan.doors) K(d, "off");
  for (const win of plan.windows) K(win, "off");
  for (const r of plan.rooms) r.poly = r.poly.map(q => [q[0] * k, q[1] * k]);
  for (const dim of plan.dims) K(dim, "x1", "y1", "x2", "y2");
  for (const f of plan.furniture || []) K(f, "x", "y", "elev");
  if (plan.imgRect) K(plan.imgRect, "x", "y", "w", "h");
  if (plan.imgRect0) K(plan.imgRect0, "x", "y", "w", "h");
  plan.scaleSource = `手动校准(${knownMm}mm)`;
  return plan;
}
// 合并被 AI 拆开的大开间：两个开放房间(客/餐)若恰好拼成一个外包矩形（面积吻合、互不重叠），则合并
function mergeOpenRooms(plan) {
  const open = new Set(["living_room", "dining_room"]);
  const changed = true;
  while (true) {
    let merged = false;
    outer:
    for (let i = 0; i < plan.rooms.length; i++) {
      for (let j = i + 1; j < plan.rooms.length; j++) {
        const A = plan.rooms[i], B = plan.rooms[j];
        if (!open.has(A.type) || !open.has(B.type)) continue;
        const aA = roomArea(A.poly), aB = roomArea(B.poly);
        const xs = [...A.poly, ...B.poly].map(q => q[0]), ys = [...A.poly, ...B.poly].map(q => q[1]);
        const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
        const boxArea = Math.abs((maxX - minX) * (maxY - minY)) / 1e6 * 1e6; // mm² 量纲与 roomArea(m²) 不同，下面统一用归一/毫米平方
        const aSum = Math.abs(aA) + Math.abs(aB);
        // roomArea 返回 m²；这里用顶点坐标直接算 mm² 版面积
        const area2 = poly => Math.abs(poly.reduce((t, q, k) => { const q2 = poly[(k + 1) % poly.length]; return t + q[0] * q2[1] - q2[0] * q[1]; }, 0)) / 2;
        const box = Math.abs((maxX - minX) * (maxY - minY));
        const sum2 = area2(A.poly) + area2(B.poly);
        // 要求：拼成外包矩形（误差 4%），且两者重叠面积很小（<8%）→ 属拼接而非包含
        const ov = overlapArea(A.poly, B.poly);
        if (Math.abs(box - sum2) / box < 0.04 && ov / Math.min(area2(A.poly), area2(B.poly)) < 0.08) {
          const names = new Set([A.name, B.name].filter(Boolean));
          const mergedRoom = {
            ...A,
            name: names.has("客厅") && names.has("餐厅") ? "客餐厅" : (A.name || B.name),
            type: "living_room",
            poly: [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]],
          };
          plan.rooms.splice(j, 1); plan.rooms.splice(i, 1, mergedRoom);
          merged = true; break outer;
        }
      }
    }
    if (!merged) break;
  }
}

// 两多边形重叠面积（栅格采样近似，量纲=坐标²）
function overlapArea(a, b) {
  const all = [...a, ...b];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of all) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
  const N = 24, ow = (maxX - minX) / N, oh = (maxY - minY) / N, half = 0.001;
  let cnt = 0, tot = 0;
  for (let ix = 0; ix < N; ix++) for (let iy = 0; iy < N; iy++) {
    const x = minX + (ix + 0.5) * ow, y = minY + (iy + 0.5) * oh;
    if (pointInPoly(x, y, a) && pointInPoly(x, y, b)) cnt++;
    tot++;
  }
  return cnt / tot * (maxX - minX) * (maxY - minY);
}