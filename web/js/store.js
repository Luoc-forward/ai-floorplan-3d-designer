// 全局状态、数据模型、撤销重做、内置示例户型
export const DEFAULT_WALL_H = 2800;

let _seq = 1;
export const uid = (p = "id") => `${p}${Date.now().toString(36)}_${_seq++}`;

export const ROOM_TYPES = {
  living_room: "客厅", dining_room: "餐厅", bedroom: "卧室", master_bedroom: "主卧",
  kitchen: "厨房", bathroom: "卫生间", balcony: "阳台", study: "书房",
  entrance: "玄关", storage: "储物间", other: "其他",
};

export function emptyPlan() {
  return {
    name: "我的户型",
    image: null, imageW: 0, imageH: 0, pxPerMm: 0, north: 0,
    wallHeight: DEFAULT_WALL_H,
    wallColor: "#ffffff", ceilColor: "#ffffff",
    walls: [], doors: [], windows: [], rooms: [], dims: [], furniture: [],
  };
}

// ---------- 内置两居室（毫米坐标，手工数据，无需联网即可演示） ----------
export function builtinPlan() {
  const p = emptyPlan();
  p.name = "两居室示例";
  // 外包 9600 x 7200
  const T = 200, t = 100;
  const W = (x1, y1, x2, y2, thick = T, load = true) =>
    p.walls.push({ id: uid("w"), x1, y1, x2, y2, thick, load });
  // 外墙
  W(0, 0, 9600, 0); W(9600, 0, 9600, 7200); W(0, 7200, 9600, 7200); W(0, 0, 0, 7200);
  // 内墙：竖墙 x=4200（客厅/主卧之间，上半段）
  W(4200, 0, 4200, 3000, t, false); W(4200, 3900, 4200, 7200, t, false);
  // 横墙 y=3900（卧室区与走廊/厨卫）
  W(4200, 3900, 9600, 3900, t, false);
  // 竖墙 x=7000（主次卧分隔）
  W(7000, 0, 7000, 3900, t, false);
  // 厨卫竖墙 x=6200
  W(6200, 3900, 6200, 7200, t, false);
  // 卫生间横墙 y=5600
  W(4200, 5600, 6200, 5600, t, false);

  const D = (wallIdx, off, width, kind = "swing", hingeSide = "left", inward = true) =>
    p.doors.push({ id: uid("d"), wallId: p.walls[wallIdx].id, off, width, kind, hingeSide, inward, open: 30 });
  // wall 索引：0北 1东 2南 3西 4竖上 5竖下 6横3900 7竖7000 8竖6200 9卫横5600
  D(2, 1500, 1000, "swing", "left", true);        // 入户门（南墙）
  D(4, 2200, 900, "swing", "left", true);         // 主卧门
  D(7, 2900, 850, "swing", "right", true);        // 次卧门
  D(8, 4600, 800, "swing", "right", true);        // 厨房门
  D(9, 1100, 750, "swing", "left", true);         // 卫生间门
  p.doors[0].width = 1000;

  const Win = (wallIdx, off, width, kind = "normal", sill = 900, height = 1400) =>
    p.windows.push({ id: uid("win"), wallId: p.walls[wallIdx].id, off, width, kind, sill, height });
  Win(0, 900, 2200);     // 客厅北窗（落地阳台门联窗感）
  Win(0, 5000, 1500, "bay"); // 主卧飘窗
  Win(1, 1200, 1500);    // 次卧东窗
  Win(2, 7600, 1200);    // 厨房南窗
  Win(3, 4200, 1000);    // 卫生间西窗? 西墙是客餐厅 -> 改餐厅窗
  p.windows[4].off = 4200;

  const R = (name, type, poly, floor = "#e3d3b6") =>
    p.rooms.push({ id: uid("r"), name, type, poly, floorColor: floor });
  R("客餐厅", "living_room", [[0,0],[4200,0],[4200,7200],[0,7200]], "#e7d7ba");
  R("主卧", "master_bedroom", [[4200,0],[7000,0],[7000,3900],[4200,3900]], "#e2cfac");
  R("次卧", "bedroom", [[7000,0],[9600,0],[9600,3900],[7000,3900]], "#e6d5b6");
  R("厨房", "kitchen", [[6200,5600],[9600,5600],[9600,7200],[6200,7200]], "#eae3d6");
  R("卫生间", "bathroom", [[4200,5600],[6200,5600],[6200,7200],[4200,7200]], "#e8e6e1");
  R("走廊", "other", [[4200,3900],[6200,3900],[6200,5600],[4200,5600]], "#e7d7ba");
  R("餐厅", "dining_room", [[6200,3900],[9600,3900],[9600,5600],[6200,5600]], "#e7d7ba");

  p.dims.push({ id: uid("dim"), text: "9600", x1: 0, y1: 7600, x2: 9600, y2: 7600 });
  p.dims.push({ id: uid("dim"), text: "7200", x1: -450, y1: 0, x2: -450, y2: 7200 });

  // 几件示意家具
  p.furniture.push(
    { id: uid("f"), type: "sofa", name: "三人沙发", x: 1800, y: 1200, rot: 0, sx: 1, sy: 1, sz: 1, elev: 0, color: "#8aa0bd" },
    { id: uid("f"), type: "tv", name: "电视柜", x: 1800, y: 350, rot: 0, sx: 1, sy: 1, sz: 1, elev: 0, color: "#eeeeee" },
    { id: uid("f"), type: "bed", name: "双人床", x: 5600, y: 1900, rot: 0, sx: 1, sy: 1, sz: 1, elev: 0, color: "#b9a78f" },
    { id: uid("f"), type: "wardrobe", name: "衣柜", x: 6850, y: 1900, rot: 0, sx: 1, sy: 1, sz: 1, elev: 0, color: "#cbb89b" },
    { id: uid("f"), type: "fridge", name: "冰箱", x: 6500, y: 6800, rot: 0, sx: 1, sy: 1, sz: 1, elev: 0, color: "#dfe5ea" },
  );
  return p;
}

// ---------- 带历史的状态仓库 ----------
export class Store {
  constructor() {
    this.plan = emptyPlan();
    this.undoStack = [];
    this.redoStack = [];
    this.listeners = [];
    this._limit = 80;
  }
  onChange(fn) { this.listeners.push(fn); }
  emit(reason) { this.listeners.forEach(f => f(reason)); }

  load(plan, reason = "load") {
    this.plan = plan;
    this.undoStack = []; this.redoStack = [];
    this.emit(reason);
  }
  snapshot() { return JSON.stringify(this.plan); }
  restore(s) { this.plan = JSON.parse(s); this.emit("restore"); }

  // 在一个事务里改数据，结束后自动入栈
  begin() { this._cap = this.snapshot(); }
  commit(reason = "edit") {
    if (!this._cap) return;
    if (this._cap !== this.snapshot()) {
      this.undoStack.push(this._cap);
      if (this.undoStack.length > this._limit) this.undoStack.shift();
      this.redoStack = [];
      this.emit(reason);
    }
    this._cap = null;
  }
  undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(this.snapshot());
    this.restore(this.undoStack.pop());
  }
  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(this.snapshot());
    this.restore(this.redoStack.pop());
  }
  canUndo() { return this.undoStack.length > 0; }
  canRedo() { return this.redoStack.length > 0; }

  findWall(id) { return this.plan.walls.find(w => w.id === id); }
  wallLength(w) { return Math.hypot(w.x2 - w.x1, w.y2 - w.y1); }
  // 沿墙 off 处的世界坐标与方向角
  pointAt(w, off) {
    const L = this.wallLength(w) || 1;
    const u = Math.min(1, Math.max(0, off / L));
    return { x: w.x1 + (w.x2 - w.x1) * u, y: w.y1 + (w.y2 - w.y1) * u, L };
  }
  wallAngle(w) { return Math.atan2(w.y2 - w.y1, w.x2 - w.x1); }
}
