// 家具库：程序化定义（盒子组合），2D 用俯视图元，3D 用 buildFurniture 生成网格
// 尺寸单位 mm；parts: 相对家具中心的盒子 [w,d,h,  offX,offY,elevation, 角色色]
export const FURNITURE = [
  { type: "sofa", name: "三人沙发", ico: "🛋", w: 2200, d: 880, h: 850, color: "#8aa0bd", cat: "客厅",
    parts: [
      [2200, 820, 260, 0, 60, 0, "seat"],
      [2200, 200, 700, 0, -340, 150, "back"],
      [200, 820, 420, -1000, 60, 150, "arm"],
      [200, 820, 420, 1000, 60, 150, "arm"],
    ]},
  { type: "sofa2", name: "双人沙发", ico: "🛋", w: 1600, d: 850, h: 800, color: "#9bb0c8", cat: "客厅",
    parts: [[1600,800,260,0,60,0,"seat"],[1600,200,680,0,-330,140,"back"],[180,800,400,-710,60,140,"arm"],[180,800,400,710,60,140,"arm"]]},
  { type: "armchair", name: "单人椅", ico: "🪑", w: 850, d: 850, h: 800, color: "#a7b6c8", cat: "客厅",
    parts: [[850,780,240,0,60,0,"seat"],[850,180,660,0,-320,140,"back"],[160,780,400,-345,60,140,"arm"],[160,780,400,345,60,140,"arm"]]},
  { type: "coffee", name: "茶几", ico: "🪵", w: 1200, d: 600, h: 420, color: "#9c7a54", cat: "客厅",
    parts: [[1200,600,60,0,0,380,"wood"],[80,80,380,-540,-240,0,"leg"],[80,80,380,540,-240,0,"leg"],[80,80,380,-540,240,0,"leg"],[80,80,380,540,240,0,"leg"]]},
  { type: "tv", name: "电视柜", ico: "📺", w: 1800, d: 400, h: 450, color: "#c8cdd3", cat: "客厅",
    parts: [[1800,400,420,0,0,0,"cabinet"],[1700,60,600,0,-180,420,"screen"]]},
  { type: "dining", name: "餐桌(4椅)", ico: "🍽", w: 1400, d: 850, h: 750, color: "#a9815a", cat: "餐厅",
    parts: [[1400,850,60,0,0,720,"wood"],[100,100,720,-620,-350,0,"leg"],[100,100,720,620,-350,0,"leg"],[100,100,720,-620,350,0,"leg"],[100,100,720,620,350,0,"leg"]]},
  { type: "chair", name: "餐椅", ico: "🪑", w: 450, d: 480, h: 900, color: "#b08d63", cat: "餐厅",
    parts: [[450,450,50,0,20,450,"wood"],[450,60,450,0,-210,450,"wood"]]},
  { type: "bed", name: "双人床1.8m", ico: "🛏", w: 1800, d: 2100, h: 550, color: "#b9a78f", cat: "卧室",
    parts: [[1800,2100,300,0,0,0,"frame"],[1700,1900,180,0,40,300,"mattress"],[1800,200,900,0,-950,0,"head"]]},
  { type: "bed15", name: "单人床1.5m", ico: "🛏", w: 1500, d: 2000, h: 550, color: "#c2b29c", cat: "卧室",
    parts: [[1500,2000,300,0,0,0,"frame"],[1400,1800,180,0,40,300,"mattress"],[1500,180,850,0,-910,0,"head"]]},
  { type: "nightstand", name: "床头柜", ico: "🗄", w: 500, d: 420, h: 500, color: "#cbb89b", cat: "卧室",
    parts: [[500,420,500,0,0,0,"cabinet"]]},
  { type: "wardrobe", name: "衣柜", ico: "🚪", w: 1800, d: 600, h: 2200, color: "#cbb89b", cat: "卧室",
    parts: [[1800,600,2200,0,0,0,"cabinet"]]},
  { type: "desk", name: "书桌", ico: "🖥", w: 1200, d: 600, h: 750, color: "#b08d63", cat: "书房",
    parts: [[1200,600,50,0,0,720,"wood"],[60,60,720,-540,-240,0,"leg"],[60,60,720,540,-240,0,"leg"],[60,60,720,-540,240,0,"leg"],[60,60,720,540,240,0,"leg"]]},
  { type: "bookshelf", name: "书柜", ico: "📚", w: 900, d: 350, h: 2000, color: "#a9815a", cat: "书房",
    parts: [[900,350,2000,0,0,0,"cabinet"]]},
  { type: "fridge", name: "冰箱", ico: "🧊", w: 700, d: 700, h: 1850, color: "#dfe5ea", cat: "厨房",
    parts: [[700,700,1850,0,0,0,"appliance"]]},
  { type: "stove", name: "灶台", ico: "🔥", w: 750, d: 600, h: 850, color: "#9aa2ab", cat: "厨房",
    parts: [[750,600,850,0,0,0,"cabinet"]]},
  { type: "sink", name: "水槽柜", ico: "🚰", w: 800, d: 600, h: 850, color: "#aeb6bd", cat: "厨房",
    parts: [[800,600,850,0,0,0,"cabinet"]]},
  { type: "counter", name: "橱柜", ico: "🗄", w: 1500, d: 600, h: 850, color: "#b6a98f", cat: "厨房",
    parts: [[1500,600,850,0,0,0,"cabinet"]]},
  { type: "toilet", name: "马桶", ico: "🚽", w: 420, d: 700, h: 750, color: "#f2f4f6", cat: "卫浴",
    parts: [[420,460,350,0,80,0,"ceramic"],[400,260,500,0,-220,250,"ceramic"]]},
  { type: "basin", name: "洗手台", ico: "🧼", w: 700, d: 500, h: 850, color: "#eef1f3", cat: "卫浴",
    parts: [[700,500,800,0,0,0,"cabinet"],[620,420,120,0,0,800,"ceramic"]]},
  { type: "shower", name: "淋浴房", ico: "🚿", w: 900, d: 900, h: 2000, color: "#cfe3f2", cat: "卫浴",
    parts: [[900,60,2000,0,-420,0,"glass"],[60,900,2000,-420,0,0,"glass"]]},
  { type: "bathtub", name: "浴缸", ico: "🛁", w: 1700, d: 800, h: 580, color: "#e8edf0", cat: "卫浴",
    parts: [[1700,800,580,0,0,0,"ceramic"]]},
  { type: "plant", name: "绿植", ico: "🪴", w: 500, d: 500, h: 1200, color: "#4f8f4f", cat: "装饰",
    parts: [[360,360,400,0,0,0,"pot"],[420,420,700,0,0,450,"leaf"]]},
  { type: "lamp", name: "落地灯", ico: "💡", w: 350, d: 350, h: 1650, color: "#e8d9a8", cat: "装饰",
    parts: [[300,300,40,0,0,0,"base"],[30,30,1500,0,0,40,"metal"],[260,260,180,0,0,1500,"shade"]]},
  { type: "rug", name: "地毯", ico: "🟫", w: 2000, d: 1400, h: 20, color: "#c9a48a", cat: "装饰",
    parts: [[2000,1400,20,0,0,0,"fabric"]]},
  { type: "cabinet", name: "储物柜", ico: "🗄", w: 1000, d: 450, h: 1200, color: "#c2b29c", cat: "装饰",
    parts: [[1000,450,1200,0,0,0,"cabinet"]]},
];

const MAP = Object.fromEntries(FURNITURE.map(f => [f.type, f]));
export const getFurnitureDef = (type) => MAP[type] || MAP.cabinet;

export function makeFurniture(type) {
  const def = getFurnitureDef(type);
  return {
    id: "f" + Date.now().toString(36) + "_" + Math.floor(Math.random() * 1e4),
    type, name: def.name,
    x: 0, y: 0, rot: 0, elev: 0,
    sx: 1, sy: 1, sz: 1,
    color: def.color,
  };
}

export const FURN_CATS = ["客厅", "餐厅", "卧室", "书房", "厨房", "卫浴", "装饰"];