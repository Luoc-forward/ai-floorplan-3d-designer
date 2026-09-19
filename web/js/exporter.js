// 导出：修改后户型图 PNG / SVG / JSON / 3D截图
import { wallLen, planContentBounds } from "./geometry.js";
import { getFurnitureDef } from "./furniture.js";

function download(url, name) {
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
}
export function downloadJSON(obj, name) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  download(URL.createObjectURL(blob), name);
}

// ---------- SVG 户型图 ----------
export function planToSVG(plan, withBgImage = false) {
  const b = planContentBounds(plan, { image: !!withBgImage });
  const minX = b.x - 1200, minY = b.y - 1200;
  const maxX = b.x + b.w + 1200, maxY = b.y + b.h + 1200;
  const W = maxX - minX, H = maxY - minY;
  const X = (x) => x - minX, Y = (y) => y - minY;
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`);
  parts.push(`<rect width="${W}" height="${H}" fill="#ffffff"/>`);
  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="none" stroke="#ccc" stroke-width="10"/>`);

  if (withBgImage && plan.image && plan.imgRect) {
    parts.push(`<image href="${plan.image}" x="${X(plan.imgRect.x)}" y="${Y(plan.imgRect.y)}" width="${plan.imgRect.w}" height="${plan.imgRect.h}" opacity="0.45"/>`);
  }

  // 房间
  for (const r of plan.rooms) {
    const pts = r.poly.map(q => `${X(q[0])},${Y(q[1])}`).join(" ");
    parts.push(`<polygon points="${pts}" fill="${r.floorColor || "#e7d7ba"}" fill-opacity="0.28"/>`);
    const cx = r.poly.reduce((s, q) => s + q[0], 0) / r.poly.length;
    const cy = r.poly.reduce((s, q) => s + q[1], 0) / r.poly.length;
    parts.push(`<text x="${X(cx)}" y="${Y(cy)}" font-size="260" text-anchor="middle" fill="#333" font-family="Microsoft YaHei">${esc(r.name || "")}</text>`);
    if (r.areaM2) parts.push(`<text x="${X(cx)}" y="${Y(cy) + 300}" font-size="200" text-anchor="middle" fill="#888">${r.areaM2.toFixed(1)}㎡</text>`);
  }

  // 墙体（含洞）
  for (const w of plan.walls) {
    const L = wallLen(w), ux = (w.x2 - w.x1) / L, uy = (w.y2 - w.y1) / L, nx = -uy, ny = ux, h2 = w.thick / 2;
    const gaps = [];
    for (const d of plan.doors) if (d.wallId === w.id) gaps.push([d.off - d.width / 2, d.off + d.width / 2]);
    for (const win of plan.windows) if (win.wallId === w.id) gaps.push([win.off - win.width / 2, win.off + win.width / 2]);
    gaps.sort((a, b) => a[0] - b[0]);
    let cur = 0; const segs = [];
    for (const [a, b] of gaps) { if (a > cur) segs.push([cur, Math.min(a, L)]); cur = Math.max(cur, b); }
    segs.push([cur, L]);
    for (const [a, b] of segs) {
      if (b - a < 5) continue;
      const p = (off, side) => [X(w.x1 + ux * off + nx * h2 * side), Y(w.y1 + uy * off + ny * h2 * side)];
      const p1 = p(a, 1), p2 = p(b, 1), p3 = p(b, -1), p4 = p(a, -1);
      parts.push(`<polygon points="${p1[0]},${p1[1]} ${p2[0]},${p2[1]} ${p3[0]},${p3[1]} ${p4[0]},${p4[1]}" fill="${w.load ? "#262a31" : "#3a3f48"}"/>`);
    }
  }

  // 门
  for (const d of plan.doors) {
    const w = plan.walls.find(z => z.id === d.wallId); if (!w) continue;
    const L = wallLen(w), ux = (w.x2 - w.x1) / L, uy = (w.y2 - w.y1) / L;
    const cx = w.x1 + ux * d.off, cy = w.y1 + uy * d.off;
    const hl = d.hingeSide === "left" ? -1 : 1;
    const hx = cx + ux * hl * d.width / 2, hy = cy + uy * hl * d.width / 2;
    const ang0 = Math.atan2(uy * hl, ux * hl);
    const open = (d.open ?? 30) * Math.PI / 180;
    const sign = d.inward ? 1 : -1;
    const nx = -uy, ny = ux;
    const ex = hx + d.width * Math.cos(ang0 + sign * hl * open);
    const ey = hy + d.width * Math.sin(ang0 + sign * hl * open);
    if (d.kind === "sliding") {
      parts.push(`<line x1="${X(cx - ux*d.width/2)}" y1="${Y(cy - uy*d.width/2)}" x2="${X(cx)}" y2="${Y(cy)}" stroke="#1c5fc0" stroke-width="14"/>`);
      parts.push(`<line x1="${X(cx)}" y1="${Y(cy)}" x2="${X(cx + ux*d.width/2)}" y2="${Y(cy + uy*d.width/2)}" stroke="#1c5fc0" stroke-width="14"/>`);
    } else {
      parts.push(`<line x1="${X(hx)}" y1="${Y(hy)}" x2="${X(ex)}" y2="${Y(ey)}" stroke="#1c5fc0" stroke-width="22"/>`);
      const a0 = Math.min(ang0, ang0 + sign * hl * open), a1 = Math.max(ang0, ang0 + sign * hl * open);
      const x0 = hx + d.width * Math.cos(a0), y0 = hy + d.width * Math.sin(a0);
      const x1 = hx + d.width * Math.cos(a1), y1 = hy + d.width * Math.sin(a1);
      parts.push(`<path d="M ${X(x0)} ${Y(y0)} A ${d.width} ${d.width} 0 0 1 ${X(x1)} ${Y(y1)}" fill="none" stroke="#1c5fc0" stroke-width="10"/>`);
    }
  }

  // 窗
  for (const win of plan.windows) {
    const w = plan.walls.find(z => z.id === win.wallId); if (!w) continue;
    const L = wallLen(w), ux = (w.x2 - w.x1) / L, uy = (w.y2 - w.y1) / L, nx = -uy, ny = ux, h2 = w.thick / 2;
    const a = win.off - win.width / 2, b = win.off + win.width / 2;
    for (const off of [-h2, h2]) {
      parts.push(`<line x1="${X(w.x1 + ux*a + nx*off)}" y1="${Y(w.y1 + uy*a + ny*off)}" x2="${X(w.x1 + ux*b + nx*off)}" y2="${Y(w.y1 + uy*b + ny*off)}" stroke="#3d7fc4" stroke-width="10"/>`);
      parts.push(`<line x1="${X(w.x1 + ux*a + nx*off*0.3)}" y1="${Y(w.y1 + uy*a + ny*off*0.3)}" x2="${X(w.x1 + ux*b + nx*off*0.3)}" y2="${Y(w.y1 + uy*b + ny*off*0.3)}" stroke="#3d7fc4" stroke-width="6"/>`);
    }
  }

  // 家具
  for (const f of plan.furniture) {
    const def = getFurnitureDef(f.type);
    const w = def.w * f.sx, d = def.d * f.sy;
    parts.push(`<g transform="translate(${X(f.x)},${Y(f.y)}) rotate(${(-f.rot * 180 / Math.PI).toFixed(1)})">`);
    parts.push(`<rect x="${-w/2}" y="${-d/2}" width="${w}" height="${d}" rx="40" fill="${f.color || def.color}" stroke="rgba(0,0,0,.35)" stroke-width="8"/>`);
    parts.push(`</g>`);
  }

  // 尺寸
  for (const dim of plan.dims) {
    parts.push(`<line x1="${X(dim.x1)}" y1="${Y(dim.y1)}" x2="${X(dim.x2)}" y2="${Y(dim.y2)}" stroke="#b0387a" stroke-width="8"/>`);
    const mx = X((dim.x1 + dim.x2) / 2), my = Y((dim.y1 + dim.y2) / 2) - 80;
    parts.push(`<text x="${mx}" y="${my}" font-size="220" text-anchor="middle" fill="#b0387a">${esc(dim.text)}mm</text>`);
  }

  parts.push(`<text x="${W - 40}" y="${H - 40}" font-size="160" text-anchor="end" fill="#aaa">AI户型3D设计器导出 · ${new Date().toLocaleString("zh-CN")}</text>`);
  parts.push(`</svg>`);
  return parts.join("\n");
}

export function exportSVG(plan, name, withBg) {
  const svg = planToSVG(plan, withBg);
  const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  download(URL.createObjectURL(blob), name);
}

// SVG -> PNG（浏览器栅格化）
export async function exportPNGFromSVG(plan, name, withBg, scale = 0.5) {
  const svg = planToSVG(plan, withBg);
  const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
  const cv = document.createElement("canvas");
  cv.width = Math.round(img.width * scale);
  cv.height = Math.round(img.height * scale);
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.drawImage(img, 0, 0, cv.width, cv.height);
  download(cv.toDataURL("image/png"), name);
}