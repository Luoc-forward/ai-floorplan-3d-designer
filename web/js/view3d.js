// 3D 视图：three.js 场景构建 + 家具编辑 + 第一人称漫游碰撞
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { wallLen, planBounds, distPointSeg, roomArea, doorSwingSide, roomAt } from "./geometry.js";
import { getFurnitureDef } from "./furniture.js";

const M = 1 / 1000; // mm -> m

const ROLE_COLORS = {
  frame: "#8a6a48", mattress: "#f2efe9", head: "#7d6548", wood: "#9c7a54",
  leg: "#6e5538", cabinet: "#b08d63", screen: "#1c1f26", ceramic: "#f4f6f8",
  glass: "#bcd9ec", appliance: "#dfe5ea", leaf: "#3f7d43", pot: "#b06a3f",
  metal: "#9aa2ab", shade: "#f3e0a6", base: "#555",
};

export class View3D {
  constructor(canvas, store, hooks) {
    this.cv = canvas; this.store = store; this.hooks = hooks || {};
    this.mode = "3d";
    this.showCeil = false;
    this.night = false;
    this.selFurn = null;
    this.keys = {}; this.yaw = 0; this.pitch = 0;
    this.walkPos = new THREE.Vector3();
    this.colliders = []; this.furnBoxes = [];
    this.doorMeshes = []; this.furnGroups = new Map();
    this._drag = null; this.joy = null; this._hadPointerLock = false;
    this.init();
    store.onChange(() => this.build());
    this.loop();
  }

  init() {
    this.renderer = new THREE.WebGLRenderer({ canvas: this.cv, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xf4f0e8);
    this.cam = new THREE.PerspectiveCamera(62, 1, 0.05, 400);
    this.cam.position.set(6, 8, 10);

    this.orbit = new OrbitControls(this.cam, this.cv);
    this.orbit.enableDamping = true; this.orbit.maxPolarAngle = Math.PI / 2.05;
    this.orbit.target.set(4, 0, 4);

    this.hemi = new THREE.HemisphereLight(0xffffff, 0xf3ebdc, 1.5);
    this.scene.add(this.hemi);
    this.ambient = new THREE.AmbientLight(0xfffbf4, 0.5);
    this.scene.add(this.ambient);
    this.sun = new THREE.DirectionalLight(0xfff4e0, 1.35);
    this.sun.position.set(8, 14, 6);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    const sc = this.sun.shadow.camera;
    sc.left = -20; sc.right = 20; sc.top = 20; sc.bottom = -20; sc.far = 60;
    this.scene.add(this.sun);
    this.nightLights = [];

    this.root = new THREE.Group(); this.scene.add(this.root);
    this.ray = new THREE.Raycaster();
    this.groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

    this.resize();
    new ResizeObserver(() => this.resize()).observe(this.cv.parentElement);
    this.bindInput();
  }

  resize() {
    const r = this.cv.getBoundingClientRect();
    if (!r.width) return;
    this.renderer.setSize(r.width, r.height, false);
    this.cam.aspect = r.width / r.height; this.cam.updateProjectionMatrix();
  }

  // ---------------- 场景构建 ----------------
  build() {
    while (this.root.children.length) {
      const c = this.root.children.pop();
      c.traverse(o => { o.geometry?.dispose?.(); if (o.material) { const ms = Array.isArray(o.material) ? o.material : [o.material]; ms.forEach(m => m.dispose?.()); } });
      this.root.remove(c);
    }
    this.colliders = []; this.furnBoxes = []; this.doorMeshes = []; this.furnGroups = new Map();
    this.bounds = planBounds(this.store.plan);

    this.buildFloor();
    for (const w of this.store.plan.walls) this.buildWall(w);
    for (const d of this.store.plan.doors) this.buildDoor(d);
    for (const win of this.store.plan.windows) this.buildWindow(win);
    for (const f of this.store.plan.furniture) this.buildFurniture(f);
    this.buildCeiling();
    this.applyLight();
    this.drawMinimap();
  }

  mat(color, opt = {}) {
    const m = new THREE.MeshStandardMaterial({
      color, roughness: opt.rough ?? 0.85, metalness: opt.metal ?? 0,
      transparent: !!opt.opacity && opt.opacity < 1, opacity: opt.opacity ?? 1,
      side: opt.side ?? THREE.FrontSide,
      polygonOffset: !!opt.polyOff, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    if (opt.glow) { m.emissive = new THREE.Color(color); m.emissiveIntensity = opt.glow; }
    return m;
  }

  sortedRooms() {
    return [...this.store.plan.rooms].sort((a, b) => (b.areaM2 || roomArea(b.poly)) - (a.areaM2 || roomArea(a.poly)));
  }

  buildFloor() {
    const p = this.store.plan;
    if (!p.rooms.length) {
      const b = this.bounds;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(b.w * M, b.h * M), this.mat("#e7d7ba", { side: THREE.DoubleSide }));
      m.rotation.x = Math.PI / 2; m.position.set((b.x + b.w / 2) * M, 0, (b.y + b.h / 2) * M);
      m.receiveShadow = true; this.root.add(m);
    } else {
      // 大房间先画，小房间覆盖在上，避免重叠房间颜色错乱
      for (const r of this.sortedRooms()) {
        const shape = new THREE.Shape();
        r.poly.forEach((q, i) => i ? shape.lineTo(q[0] * M, q[1] * M) : shape.moveTo(q[0] * M, q[1] * M));
        const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape),
          this.mat(r.floorColor || "#e7d7ba", { side: THREE.DoubleSide, rough: 0.95, polyOff: true }));
        mesh.rotation.x = Math.PI / 2; mesh.receiveShadow = true;
        this.root.add(mesh);
      }
    }
    const b = this.bounds, pad = 3000;
    const ground = new THREE.Mesh(new THREE.PlaneGeometry((b.w + pad * 2) * M, (b.h + pad * 2) * M),
      this.mat("#ddd2bf", { side: THREE.DoubleSide, rough: 1 }));
    ground.rotation.x = Math.PI / 2;
    ground.position.set((b.x + b.w / 2) * M, -0.02, (b.y + b.h / 2) * M);
    ground.receiveShadow = true;
    this.root.add(ground);
  }

  wallGaps(w) {
    const p = this.store.plan, gaps = [];
    for (const d of p.doors) if (d.wallId === w.id)
      gaps.push({ a: d.off - d.width / 2, b: d.off + d.width / 2, top: 2100, kind: "door", ref: d });
    for (const win of p.windows) if (win.wallId === w.id)
      gaps.push({ a: win.off - win.width / 2, b: win.off + win.width / 2, top: win.sill + win.height, bottom: win.sill, kind: "win" });
    gaps.sort((x, y) => x.a - y.a);
    return gaps;
  }

  buildWall(w) {
    const p = this.store.plan;
    const L = wallLen(w), H = p.wallHeight;
    const shape = new THREE.Shape();
    shape.moveTo(0, 0); shape.lineTo(L * M, 0); shape.lineTo(L * M, H * M); shape.lineTo(0, H * M);
    for (const g of this.wallGaps(w)) {
      const bot = g.bottom ?? 0;
      const path = new THREE.Path();
      path.moveTo(g.a * M, bot * M);
      path.lineTo(g.a * M, g.top * M);
      path.lineTo(g.b * M, g.top * M);
      path.lineTo(g.b * M, bot * M);
      shape.holes.push(path);
    }
    const geo = new THREE.ExtrudeGeometry(shape, { depth: w.thick * M, bevelEnabled: false });
    geo.translate(0, 0, -w.thick * M / 2);
    const mesh = new THREE.Mesh(geo, this.mat(w.load ? shade(p.wallColor, -10) : p.wallColor, { rough: 0.97, glow: 0.22 }));
    const ang = Math.atan2(w.y2 - w.y1, w.x2 - w.x1);
    mesh.rotation.y = -ang;
    mesh.position.set(w.x1 * M, 0, w.y1 * M);
    mesh.castShadow = mesh.receiveShadow = true;
    this.root.add(mesh);

    // 碰撞线段：门洞处可通行，窗洞不可
    let cur = 0; const segs = [];
    for (const g of this.wallGaps(w)) {
      if (g.kind === "door") { if (g.a > cur) segs.push([cur, g.a]); cur = Math.max(cur, g.b); }
    }
    segs.push([cur, L]);
    const ux = (w.x2 - w.x1) / L, uy = (w.y2 - w.y1) / L;
    for (const [a, b2] of segs) if (b2 - a > 30)
      this.colliders.push({ x1: w.x1 + ux * a, y1: w.y1 + uy * a, x2: w.x1 + ux * b2, y2: w.y1 + uy * b2 });
  }

  buildDoor(d) {
    const p = this.store.plan;
    const w = p.walls.find(x => x.id === d.wallId);
    if (!w) return;
    const L = wallLen(w), ang = Math.atan2(w.y2 - w.y1, w.x2 - w.x1);
    const ux = Math.cos(ang), uy = Math.sin(ang);
    const cx = w.x1 + ux * d.off, cy = w.y1 + uy * d.off;
    const doorH = 2100, t = 45;

    if (d.kind === "sliding") {
      const g = new THREE.Group();
      const glassMat = this.mat("#cfd6dd", { rough: 0.4, metal: 0.1, opacity: 0.9 });
      for (const s of [-1, 1]) {
        const panel = new THREE.Mesh(new THREE.BoxGeometry(d.width / 2 * M, doorH * M, t * M), glassMat);
        panel.position.set(s * d.width / 4 * M, doorH / 2 * M, s * 20 * M);
        g.add(panel);
      }
      g.rotation.y = -ang; g.position.set(cx * M, 0, cy * M);
      this.root.add(g);
      return;
    }

    // 门框
    const frameMat = this.mat("#e8e2d6");
    const frameG = new THREE.Group();
    const jw = 60;
    for (const s of [-1, 1]) {
      const jamb = new THREE.Mesh(new THREE.BoxGeometry(jw * M, doorH * M, (w.thick + 40) * M), frameMat);
      jamb.position.set(s * d.width / 2 * M, doorH / 2 * M, 0);
      frameG.add(jamb);
    }
    const head = new THREE.Mesh(new THREE.BoxGeometry(d.width * M, jw * M, (w.thick + 40) * M), frameMat);
    head.position.set(0, (doorH - jw / 2) * M, 0);
    frameG.add(head);
    frameG.rotation.y = -ang; frameG.position.set(cx * M, 0, cy * M);
    frameG.traverse(o => o.castShadow = true);
    this.root.add(frameG);

    // 门板枢轴：
    // 局部坐标 X=墙方向u，Z=墙法线n。hingeLeft => 合页在 -u 端，门板沿 +X；right 则整体转 180°。
    // 开门向开阔侧摆动（doorSwingSide 决定 s，单位局部 +Z=n）。
    const gs = d.hingeSide === "right" ? -1 : 1;
    const s = doorSwingSide(p, w, d);
    const hingeX = cx - gs * ux * d.width / 2;
    const hingeY = cy - gs * uy * d.width / 2;
    const pivot = new THREE.Group();
    const panel = new THREE.Mesh(new THREE.BoxGeometry(d.width * M, doorH * M, t * M), this.mat("#b98a5f", { rough: 0.6 }));
    panel.position.set(d.width / 2 * M, doorH / 2 * M, 0);
    panel.castShadow = true;
    pivot.add(panel);
    const openRad = (d.open ?? 30) * Math.PI / 180;
    // 组基础朝向使局部 X 指向门板关闭方向 gs·u；再绕 Y 转 -s·gs·α（局部 +X 摆向局部 +Z 对应 β<0）
    pivot.rotation.y = -ang + (gs < 0 ? Math.PI : 0) - s * gs * openRad;
    pivot.position.set(hingeX * M, 0, hingeY * M);
    pivot.userData = { isDoor: true, doorId: d.id };
    this.root.add(pivot);
    this.doorMeshes.push(pivot);
  }

  buildWindow(win) {
    const p = this.store.plan;
    const w = p.walls.find(x => x.id === win.wallId);
    if (!w) return;
    const ang = Math.atan2(w.y2 - w.y1, w.x2 - w.x1);
    const ux = Math.cos(ang), uy = Math.sin(ang);
    const cx = w.x1 + ux * win.off, cy = w.y1 + uy * win.off;
    const g = new THREE.Group();
    const frameMat = this.mat("#f5f7fa", { rough: 0.35, metal: 0.05 });
    const glassMat = this.mat("#a9d2ef", { opacity: 0.38, rough: 0.08 });
    const sill = win.sill, top = sill + win.height, half = win.width / 2, t = 50;

    const glass = new THREE.Mesh(new THREE.BoxGeometry(win.width * M, win.height * M, 12 * M), glassMat);
    glass.position.set(0, (sill + win.height / 2) * M, 0);
    g.add(glass);
    for (const y of [sill, top, sill + win.height / 2]) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(win.width * M, t * M, w.thick * 0.9 * M), frameMat);
      bar.position.set(0, y * M, 0); g.add(bar);
    }
    for (const x of [-half, -half / 2, half / 2, half]) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(t * M, win.height * M, w.thick * 0.9 * M), frameMat);
      bar.position.set(x * M, (sill + win.height / 2) * M, 0); g.add(bar);
    }
    if (win.kind === "bay") {
      const out = 550;
      const bay = new THREE.Mesh(new THREE.BoxGeometry(win.width * M, win.height * M, out * M), glassMat);
      bay.position.set(0, (sill + win.height / 2) * M, -out / 2 * M);
      g.add(bay);
      for (const x of [-half, half]) {
        const side = new THREE.Mesh(new THREE.BoxGeometry(t * M, win.height * M, out * M), frameMat);
        side.position.set(x * M, (sill + win.height / 2) * M, -out / 2 * M); g.add(side);
      }
    }
    if (win.kind === "floor") sill === 0;
    g.rotation.y = -ang;
    g.position.set(cx * M, 0, cy * M);
    this.root.add(g);
  }

  buildFurniture(f) {
    const def = getFurnitureDef(f.type);
    const g = new THREE.Group();
    const base = f.color || def.color;
    for (const [w, d, h, ox, oy, el, role] of def.parts) {
      let col = ROLE_COLORS[role];
      if (col == null) col = role === "shade" ? "#f3e0a6" : base;
      const opt = role === "glass" ? { opacity: 0.32, rough: 0.05 }
        : role === "screen" ? { rough: 0.25 } : {};
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(w * f.sx * M, h * f.sz * M, d * f.sy * M), this.mat(col, opt));
      mesh.position.set(ox * f.sx * M, (el + h / 2) * f.sz * M + (f.elev || 0) * M, oy * f.sy * M);
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.userData.fId = f.id;
      g.add(mesh);
    }
    g.position.set(f.x * M, (f.elev || 0) * M, f.y * M);
    g.rotation.y = -f.rot;
    g.userData.fId = f.id;
    this.root.add(g);
    this.furnGroups.set(f.id, g);
    this.furnBoxes.push({ id: f.id, x: f.x, y: f.y, r: Math.hypot(def.w * f.sx, def.d * f.sy) / 2 * 0.7 });
  }

  buildCeiling() {
    const b = this.bounds, pad = 200;
    this.ceil = new THREE.Mesh(
      new THREE.PlaneGeometry((b.w + pad * 2) * M, (b.h + pad * 2) * M),
      this.mat(this.store.plan.ceilColor || "#ffffff", { side: THREE.DoubleSide, rough: 1 }));
    this.ceil.rotation.x = Math.PI / 2;
    this.ceil.position.set((b.x + b.w / 2) * M, this.store.plan.wallHeight * M, (b.y + b.h / 2) * M);
    this.ceil.visible = this.showCeil;
    this.root.add(this.ceil);
  }

  applyLight() {
    if (!this.night) {
      this.scene.background = new THREE.Color(0xf4f0e8);
      this.hemi.intensity = 0.75; this.sun.intensity = 1.5;
      this.nightLights.forEach(l => this.scene.remove(l)); this.nightLights = [];
    } else {
      this.scene.background = new THREE.Color(0x0d1526);
      this.hemi.intensity = 0.12; this.sun.intensity = 0.12;
      for (const r of this.store.plan.rooms) {
        const cx = r.poly.reduce((s, q) => s + q[0], 0) / r.poly.length;
        const cy = r.poly.reduce((s, q) => s + q[1], 0) / r.poly.length;
        const l = new THREE.PointLight(0xffe2b0, 0.9, 6, 1.6);
        l.position.set(cx * M, (this.store.plan.wallHeight - 120) * M, cy * M);
        this.scene.add(l); this.nightLights.push(l);
      }
    }
  }
  setNight(v) { this.night = v; this.applyLight(); }
  toggleCeiling() { this.showCeil = !this.showCeil; if (this.ceil) this.ceil.visible = this.showCeil; }

  // ---------------- 视角 ----------------
  frameView() {
    const b = this.bounds;
    const cx = (b.x + b.w / 2) * M, cz = (b.y + b.h / 2) * M;
    this.mode = "3d";
    this.orbit.enabled = true;
    const d = Math.max(b.w, b.h) * M;
    this.cam.position.set(cx + d * 0.35, d * 0.55 + 2, cz + d * 0.62);
    this.orbit.target.set(cx, 0.6, cz);
    this.orbit.update();
  }
  viewTop() {
    const b = this.bounds;
    const cx = (b.x + b.w / 2) * M, cz = (b.y + b.h / 2) * M;
    this.mode = "3d";
    this.orbit.enabled = true;
    this.cam.position.set(cx, Math.max(b.w, b.h) * M * 0.7 + 3, cz + 0.01);
    this.orbit.target.set(cx, 0, cz); this.orbit.update();
  }
  roomCentroid(poly) {
    let area2 = 0, cx = 0, cy = 0;
    for (let i = 0; i < poly.length; i++) {
      const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
      const cross = x1 * y2 - x2 * y1;
      area2 += cross; cx += (x1 + x2) * cross; cy += (y1 + y2) * cross;
    }
    if (Math.abs(area2) < 1e-6) {
      cx = poly.reduce((t, q) => t + q[0], 0);
      cy = poly.reduce((t, q) => t + q[1], 0);
      return [cx / poly.length, cy / poly.length];
    }
    return [cx / (3 * area2), cy / (3 * area2)];
  }

  // 在房间多边形内找一个不嵌墙、不压家具的落点；优先采用门口附近的点
  findWalkSpawn(room, prefX, prefY) {
    const candidates = [];
    if (room) {
      const [cx, cy] = this.roomCentroid(room.poly);
      const px = prefX ?? cx, py = prefY ?? cy;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      room.poly.forEach(([x, y]) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); });
      for (let x = Math.floor(x0 / 220) * 220; x <= x1; x += 220) {
        for (let y = Math.floor(y0 / 220) * 220; y <= y1; y += 220) {
          if (roomAt(this.store.plan, x, y)?.id === room.id && this.canStand(x, y)) {
            candidates.push({ x, y, d: Math.hypot(x - px, y - py) });
          }
        }
      }
      candidates.sort((a, b) => a.d - b.d);
      return candidates[0] ? { ...candidates[0], ok: true } : { x: cx, y: cy, ok: false };
    }

    const b = this.bounds;
    for (let x = b.x + 300; x <= b.x + b.w - 300; x += 300) {
      for (let y = b.y + 300; y <= b.y + b.h - 300; y += 300) {
        if (this.canStand(x, y)) candidates.push({ x, y, d: Math.hypot(x - (b.x + b.w / 2), y - (b.y + b.h / 2)) });
      }
    }
    candidates.sort((a, b) => a.d - b.d);
    return candidates[0] || { x: b.x + b.w / 2, y: b.y + b.h / 2, ok: false };
  }

  rayClearance(poly, x, y, yaw) {
    const dx = Math.sin(yaw), dy = Math.cos(yaw);
    let best = Infinity;
    for (let i = 0; i < poly.length; i++) {
      const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % poly.length];
      const vx = bx - ax, vy = by - ay;
      const den = dx * vy - dy * vx;
      if (Math.abs(den) < 1e-6) continue;
      const t = ((ax - x) * vy - (ay - y) * vx) / den;
      const u = ((ax - x) * dy - (ay - y) * dx) / den;
      if (t > 50 && u >= -0.02 && u <= 1.02) best = Math.min(best, t);
    }
    return best;
  }

  bestRoomYaw(room, xMm, yMm) {
    let bestYaw = 0, bestD = -1;
    for (let i = 0; i < 32; i++) {
      const yaw = i / 32 * Math.PI * 2;
      const d = this.rayClearance(room.poly, xMm, yMm, yaw);
      if (d > bestD) { bestD = d; bestYaw = yaw; }
    }
    return bestYaw;
  }

  viewEye() {
    const p = this.store.plan;
    const entrance = p.doors.find(d => d.id === p.entranceDoorId) || p.doors[0];
    let spawn = null, targetRoom = null, doorPoint = null;

    if (entrance) {
      const w = p.walls.find(z => z.id === entrance.wallId);
      if (w) {
        const L = wallLen(w), ux = (w.x2 - w.x1) / L, uy = (w.y2 - w.y1) / L;
        const nx = -uy, ny = ux;
        const dx = w.x1 + ux * entrance.off, dy = w.y1 + uy * entrance.off;
        const rp = roomAt(p, dx + nx * 900, dy + ny * 900);
        const rm = roomAt(p, dx - nx * 900, dy - ny * 900);
        targetRoom = rp && rm
          ? (roomArea(rp.poly) >= roomArea(rm.poly) ? rp : rm)
          : (rp || rm);
        if (targetRoom) {
          const sgn = targetRoom === rp ? 1 : -1;
          spawn = this.findWalkSpawn(targetRoom, dx + nx * 900 * sgn, dy + ny * 900 * sgn);
          doorPoint = [dx, dy];
        }
      }
    }

    if (!spawn) {
      for (const room of this.sortedRooms()) {
        targetRoom = room;
        const candidate = this.findWalkSpawn(room);
        if (candidate.ok) { spawn = candidate; break; }
      }
      if (!spawn) targetRoom = this.sortedRooms()[0] || null;
    }
    if (!spawn) spawn = this.findWalkSpawn(null);

    if (targetRoom && doorPoint) {
      const [cx, cy] = this.roomCentroid(targetRoom.poly);
      this.yaw = Math.atan2(cx - doorPoint[0], cy - doorPoint[1]);
      if (this.rayClearance(targetRoom.poly, spawn.x, spawn.y, this.yaw) < 700) {
        this.yaw = this.bestRoomYaw(targetRoom, spawn.x, spawn.y);
      }
    } else if (targetRoom) {
      this.yaw = this.bestRoomYaw(targetRoom, spawn.x, spawn.y);
    } else {
      this.yaw = 0;
    }

    this.startWalk(spawn.x, spawn.y);
  }

  // ---------------- 漫游 ----------------
  startWalk(xMm, yMm) {
    this.mode = "walk";
    this.walkPos.set(xMm * M, 1.6, yMm * M);
    this.pitch = 0;
    this.orbit.enabled = false;
    this.resize(); // 从 2D 首次切入时 canvas 刚由 display:none 变为可见，必须立即重建视口
    this._hadPointerLock = false;
    const coarsePointer = window.matchMedia?.("(pointer: coarse)").matches || "ontouchstart" in window;
    if (!coarsePointer) {
      try { const r = this.cv.requestPointerLock?.(); r?.catch?.(() => {}); } catch { /* 用户未点击或浏览器拒绝时忽略；点击画面仍可重新锁定 */ }
    }
    document.getElementById("crosshair")?.classList.remove("hidden");
    document.getElementById("joyZone")?.classList.toggle("hidden", !coarsePointer);
    const hud = document.querySelector("#view3d .hud-keys");
    if (hud) {
      this._hudOrigHtml ??= hud.innerHTML;
      hud.innerHTML = "<span>W/A/S/D 移动 · Shift 加速 · 鼠标转向（鼠标上移即抬头）</span><span>点击准星方向的门可开合 · Esc 退出；手机用左下摇杆，右侧拖动视角</span>";
    }
    this.updateWalkCam();
    this.hooks.onMode?.("walk");
  }
  exitWalk() {
    this.mode = "3d";
    this.orbit.enabled = true;
    document.exitPointerLock?.();
    document.getElementById("crosshair")?.classList.add("hidden");
    document.getElementById("joyZone")?.classList.add("hidden");
    const hud = document.querySelector("#view3d .hud-keys");
    if (hud && this._hudOrigHtml != null) hud.innerHTML = this._hudOrigHtml;
    this.hooks.onMode?.("3d");
    this.cam.position.set(this.walkPos.x, 3, this.walkPos.z + 2.5);
    this.orbit.target.set(this.walkPos.x, 1.2, this.walkPos.z);
    this.orbit.update();
  }
  updateWalkCam() {
    this.cam.position.copy(this.walkPos);
    const dir = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    dir.y = Math.tan(this.pitch);
    dir.normalize();
    this.cam.lookAt(this.walkPos.clone().add(dir));
  }
  canStand(xMm, yMm) {
    const R = 280;
    for (const s of this.colliders) if (distPointSeg(xMm, yMm, s.x1, s.y1, s.x2, s.y2).d < R) return false;
    for (const f of this.furnBoxes) if (Math.hypot(xMm - f.x, yMm - f.y) < f.r) return false;
    return true;
  }
  stepWalk(dt) {
    const speed = this.keys.shift ? 3.4 : 1.8; // m/s
    let forward = (this.keys.w ? 1 : 0) - (this.keys.s ? 1 : 0);
    let strafeLeft = (this.keys.a ? 1 : 0) - (this.keys.d ? 1 : 0);
    // 摇杆：上推前进、左推向左横移
    if (this.joy) { forward -= this.joy.y; strafeLeft -= this.joy.x; }
    const mag = Math.hypot(forward, strafeLeft);
    if (mag < 0.001) return;
    forward /= mag; strafeLeft /= mag;

    const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    const frontX = s, frontZ = c;
    const leftX = c, leftZ = -s;
    const dx = (frontX * forward + leftX * strafeLeft) * speed * dt;
    const dz = (frontZ * forward + leftZ * strafeLeft) * speed * dt;
    const nx = this.walkPos.x + dx, nz = this.walkPos.z + dz;
    if (this.canStand(nx * 1000, nz * 1000)) { this.walkPos.x = nx; this.walkPos.z = nz; }
    else {
      // 贴墙滑动：分轴尝试
      if (this.canStand(nx * 1000, this.walkPos.z * 1000)) this.walkPos.x = nx;
      if (this.canStand(this.walkPos.x * 1000, nz * 1000)) this.walkPos.z = nz;
    }
  }

  // ---------------- 输入 ----------------
  bindInput() {
    window.addEventListener("keydown", e => {
      const k = e.key.toLowerCase();
      this.keys[k] = true;
      if (this.mode !== "walk" && this.selFurn) {
        const f = this.store.plan.furniture.find(x => x.id === this.selFurn);
        if (!f) return;
        if (["q", "e", "r", "f"].includes(k)) this.store.begin();
        let changed = false;
        if (k === "q") { f.rot += Math.PI / 12; changed = true; }
        if (k === "e") { f.rot -= Math.PI / 12; changed = true; }
        if (k === "r") { f.sx = Math.min(5, f.sx * 1.08); f.sy = Math.min(5, f.sy * 1.08); f.sz = Math.min(5, f.sz * 1.04); changed = true; }
        if (k === "f") { f.sx = Math.max(0.2, f.sx / 1.08); f.sy = Math.max(0.2, f.sy / 1.08); f.sz = Math.max(0.2, f.sz / 1.04); changed = true; }
        if (changed) { this.build(); this.store.commit("家具变换"); }
      }
    });
    window.addEventListener("keyup", e => { this.keys[e.key.toLowerCase()] = false; });

    document.addEventListener("mousemove", e => {
      if (this.mode === "walk" && document.pointerLockElement === this.cv) {
        this.yaw -= e.movementX * 0.0023;
        this.pitch = Math.max(-1.3, Math.min(1.3, this.pitch - e.movementY * 0.0023));
      }
    });
    document.addEventListener("pointerlockchange", () => {
      const locked = document.pointerLockElement === this.cv;
      if (locked) this._hadPointerLock = true;
      // 仅在“曾经锁定后又被 Esc 解除”时退出；首次请求被浏览器拒绝时保留漫游，用户点击画面可重新锁定
      if (this.mode === "walk" && this._hadPointerLock && !locked) this.exitWalk();
    });

    // 点击：漫游中=锁定/开门；编辑中=选家具/拖家具
    this.cv.addEventListener("pointerdown", e => {
      if (this.mode === "walk") {
        if (e.pointerType === "touch") this._lookPtr = e.pointerId; // 触屏转视角
        else if (document.pointerLockElement !== this.cv) this.cv.requestPointerLock?.();
        else this.toggleAimedDoor();
        return;
      }
      if (e.button === 0) {
        const hit = this.pickFurniture(e);
        if (hit) {
          this._drag = { id: hit.userData.fId };
          this.cv.setPointerCapture(e.pointerId);
          this.orbit.enabled = false; // 拖家具时不要同时旋转视角
        }
      }
    });
    this.cv.addEventListener("pointermove", e => {
      if (this.mode === "walk" && this._lookPtr === e.pointerId) {
        this.yaw -= e.movementX * 0.005;
        this.pitch = Math.max(-1.3, Math.min(1.3, this.pitch - e.movementY * 0.005));
        return;
      }
      if (!this._drag) return;
      const f = this.store.plan.furniture.find(x => x.id === this._drag.id);
      const pt = this.groundAt(e);
      if (f && pt) {
        if (!this._dragMoved && Math.hypot(pt.x * 1000 - f.x, pt.z * 1000 - f.y) > 80) {
          this._dragMoved = true; this.store.begin();
        }
        if (this._dragMoved) {
          f.x = Math.round(pt.x * 1000 / 50) * 50;
          f.y = Math.round(pt.z * 1000 / 50) * 50;
          const g = this.furnGroups.get(f.id);
          if (g) g.position.set(f.x * M, (f.elev || 0) * M, f.y * M);
          const box = this.furnBoxes.find(b => b.id === f.id);
          if (box) { box.x = f.x; box.y = f.y; }
        }
      }
    });
    this.cv.addEventListener("pointerup", e => {
      if (this._lookPtr === e.pointerId) this._lookPtr = null;
      if (this._drag) {
        if (this._dragMoved) this.store.commit("拖动家具");
        else { // 纯点击：选中
          this.selFurn = this._drag.id;
          this.hooks.onSelect?.({ kind: "furniture", id: this._drag.id });
        }
        this._drag = null; this._dragMoved = false;
        if (this.mode === "3d") this.orbit.enabled = true;
      }
    });

    // 触屏摇杆
    const joy = document.getElementById("joyZone"), knob = document.getElementById("joyKnob");
    if (joy && knob) {
      let jp = null;
      joy.addEventListener("pointerdown", e => { e.preventDefault(); jp = e.pointerId; joy.setPointerCapture(jp); });
      joy.addEventListener("pointermove", e => {
        if (e.pointerId !== jp) return;
        const r = joy.getBoundingClientRect();
        let dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
        const max = r.width / 2 - 10, len = Math.hypot(dx, dy) || 1;
        const k = len > max ? max / len : 1;
        dx *= k; dy *= k;
        knob.style.transform = `translate(${dx}px,${dy}px)`;
        this.joy = { x: dx / max, y: dy / max };
      });
      const end = e => { if (e.pointerId !== jp) return; jp = null; knob.style.transform = ""; this.joy = null; };
      joy.addEventListener("pointerup", end); joy.addEventListener("pointercancel", end);
    }

    // 小地图点击传送（漫游中）
    const mini = document.getElementById("miniCv");
    mini?.addEventListener("click", e => {
      if (this.mode !== "walk" || !this.bounds) return;
      const r = mini.getBoundingClientRect();
      const pad = 600;
      const s = Math.min(mini.width / (this.bounds.w + pad * 2), mini.height / (this.bounds.h + pad * 2));
      const xMm = (e.clientX - r.left) / s - pad + this.bounds.x;
      const yMm = (e.clientY - r.top) / s - pad + this.bounds.y;
      if (this.canStand(xMm, yMm)) { this.walkPos.x = xMm * M; this.walkPos.z = yMm * M; }
    });
  }

  pickFurniture(e) {
    const r = this.cv.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(ndc, this.cam);
    const meshes = [];
    this.furnGroups.forEach(g => g.traverse(o => { if (o.isMesh && o.userData.fId) meshes.push(o); }));
    return this.ray.intersectObjects(meshes, false)[0]?.object || null;
  }
  groundAt(e) {
    const r = this.cv.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(ndc, this.cam);
    const out = new THREE.Vector3();
    return this.ray.ray.intersectPlane(this.groundPlane, out) ? out : null;
  }
  toggleAimedDoor() {
    this.ray.setFromCamera(new THREE.Vector2(0, 0), this.cam);
    const hits = this.ray.intersectObjects(this.doorMeshes, true);
    if (!hits.length) return;
    let o = hits[0].object;
    while (o && !o.userData.isDoor) o = o.parent;
    if (!o) return;
    const d = this.store.plan.doors.find(x => x.id === o.userData.doorId);
    if (!d) return;
    d.open = d.open > 5 ? 0 : 80;
    this.build();
    this.store.emit("门开合");
  }

  // ---------------- 小地图 ----------------
  drawMinimap() {
    const cv = document.getElementById("miniCv");
    if (!cv || !this.bounds) return;
    const ctx = cv.getContext("2d");
    const b = this.bounds, pad = 600;
    const s = Math.min(cv.width / (b.w + pad * 2), cv.height / (b.h + pad * 2));
    this._mini = { s, pad, b };
    const tx = (x) => (x - b.x + pad) * s, ty = (y) => (y - b.y + pad) * s;
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = "#EEF4FE"; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.strokeStyle = "#5A7096"; ctx.lineWidth = 2; ctx.lineCap = "round";
    for (const w of this.store.plan.walls) {
      ctx.beginPath(); ctx.moveTo(tx(w.x1), ty(w.y1)); ctx.lineTo(tx(w.x2), ty(w.y2)); ctx.stroke();
    }
  }
  drawMinimapDot() {
    const cv = document.getElementById("miniCv");
    if (!cv || !this._mini) return;
    this.drawMinimap();
    const ctx = cv.getContext("2d");
    const { s, pad, b } = this._mini;
    const x = (this.cam.position.x / M - b.x + pad) * s;
    const y = (this.cam.position.z / M - b.y + pad) * s;
    ctx.fillStyle = "#2F7DF6";
    ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
    const dir = new THREE.Vector3(); this.cam.getWorldDirection(dir);
    ctx.strokeStyle = "#2F7DF6"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + dir.x * 12, y + dir.z * 12); ctx.stroke();
  }

  screenshot() {
    this.renderer.render(this.scene, this.cam);
    return this.cv.toDataURL("image/png");
  }

  loop() {
    requestAnimationFrame(() => this.loop());
    const dt = Math.min(0.05, this._last ? (performance.now() - this._last) / 1000 : 0.016);
    this._last = performance.now();
    if (this.mode === "walk") { this.stepWalk(dt); this.updateWalkCam(); this.drawMinimapDot(); }
    else this.orbit.update();
    this.renderer.render(this.scene, this.cam);
  }
}

function shade(hex, amt) {
  const c = parseInt(hex.slice(1), 16);
  const clamp = v => Math.max(0, Math.min(255, v));
  const r = clamp((c >> 16) + amt), g = clamp(((c >> 8) & 255) + amt), b = clamp((c & 255) + amt);
  return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}