// 主控制器：串联首页上传、识别、2D/3D、属性面板、家具库、配色、导出
import { Store, emptyPlan, builtinPlan, uid, ROOM_TYPES } from "./store.js";
import { recognize, aiToPlan, fileToDataUrl, loadImage } from "./recognizer.js";
import { View2D } from "./view2d.js";
import { View3D } from "./view3d.js";
import { FURNITURE, FURN_CATS, makeFurniture, getFurnitureDef } from "./furniture.js";
import { exportPNGFromSVG, exportSVG, downloadJSON } from "./exporter.js";
import { planBounds, cleanupWalls, attachOpenings } from "./geometry.js";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const toast = (msg, ms = 2600) => {
  const t = $("#toast"); t.textContent = msg; t.classList.remove("hidden");
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.add("hidden"), ms);
};

const THEMES = [
  { name: "现代简约", wall: "#ffffff", floors: ["#e2d5bf", "#d8c6a8"], sw: ["#ffffff", "#3a3f48", "#8aa0bd"] },
  { name: "奶油原木", wall: "#ffffff", floors: ["#e7d7ba", "#dfcaa6"], sw: ["#ffffff", "#b98a5f", "#c9a48a"] },
  { name: "莫兰迪", wall: "#e7e4dd", floors: ["#b7ad9c", "#a9b0a2"], sw: ["#e7e4dd", "#8d9488", "#a79a8e"] },
  { name: "轻奢", wall: "#efece6", floors: ["#c9b08a", "#b99a6b"], sw: ["#efece6", "#313744", "#b08d63"] },
  { name: "工业风", wall: "#c9c6c0", floors: ["#8d8275", "#7c756b"], sw: ["#c9c6c0", "#2b2f36", "#6f7681"] },
  { name: "新中式", wall: "#f2ede2", floors: ["#a9794f", "#94633d"], sw: ["#f2ede2", "#4a2f1d", "#7d5a3a"] },
];
const WALL_COLORS = ["#ffffff", "#faf6ee", "#f4ecdd", "#efe7d8", "#e7e4dd", "#e3dcd2", "#dfe6ec", "#d8d4cc"];
const FLOOR_MATS = [
  { name: "奶油原木", c: "#e7d7ba" }, { name: "胡桃", c: "#9c7a54" }, { name: "浅橡", c: "#e2cfac" },
  { name: "灰砖", c: "#b8b8b8" }, { name: "白砖", c: "#e4e4e2" }, { name: "深色", c: "#6e5f4e" },
];

class App {
  constructor() {
    this.store = new Store();
    this.mode = "2d";
    this.sel = null;
    this.init();
  }

  async init() {
    this.view2d = new View2D($("#canvas2d"), this.store, { onSelect: s => this.setSel(s), onNotice: msg => toast(msg) });
    this.view3d = new View3D($("#canvas3d"), this.store, {
      onSelect: s => { this.setSel(s); },
      onMode: m => this.setView(m),
    });
    this.bindHome();
    this.bindTopbar();
    this.bindLeft();
    this.bindProps();
    this.bindExport();
    this.bindKeys();
    await this.checkConfig();
  }

  async checkConfig() {
    try {
      const r = await fetch("/api/config"); const j = await r.json();
      const el = $("#apiStatus");
      if (j.hasKey) { el.textContent = `✅ 识别 API 已就绪（模型 ${j.model}）`; el.className = "api-status ok"; }
      else { el.textContent = "⚠️ 未配置 ARK_API_KEY，识别不可用，但可使用示例户型/手动画墙"; el.className = "api-status err"; }
    } catch { /* 非服务器环境 */ }
  }

  // ---------------- 首页 ----------------
  bindHome() {
    const dz = $("#dropzone"), fi = $("#fileInput");
    dz.onclick = () => fi.click();
    fi.onchange = () => fi.files[0] && this.handleFile(fi.files[0]);
    dz.ondragover = (e) => { e.preventDefault(); dz.classList.add("drag"); };
    dz.ondragleave = () => dz.classList.remove("drag");
    dz.ondrop = (e) => { e.preventDefault(); dz.classList.remove("drag"); const f = e.dataTransfer.files[0]; f && this.handleFile(f); };
    window.addEventListener("paste", (e) => {
      if ($("#home").classList.contains("hidden")) return;
      const f = [...(e.clipboardData?.files || [])].find(x => x.type.startsWith("image/"));
      if (f) this.handleFile(f);
    });
    $$("[data-sample]").forEach(b => b.onclick = () => {
      if (b.dataset.sample === "draw") { this.openPlan(emptyPlan()); this.store.plan.name = "空白画布"; $("#planName").value = "空白画布"; toast("已进入空白画布，用 2D 顶部「画墙」工具开始"); }
      else if (b.dataset.sample === "1") this.loadSample1();
      else this.openPlan(builtinPlan());
    });
    this.bindHelp();
    this.bindSettings();
    this.bindImport();
    this.renderRecents();
    // 编辑后防抖写入最近方案
    this.store.onChange(() => {
      clearTimeout(this._recentTimer);
      this._recentTimer = setTimeout(() => this.saveRecent(this.store.plan), 1500);
    });
  }

  // ---------------- 使用指南 ----------------
  bindHelp() {
    const mask = $("#helpMask");
    const open = () => mask.classList.remove("hidden");
    const close = () => mask.classList.add("hidden");
    $("#btnHelp").onclick = open;
    $("#btnHelpClose").onclick = close;
    mask.onclick = (e) => { if (e.target === mask) close(); };
  }

  // ---------------- 模型设置 ----------------
  bindSettings() {
    const mask = $("#settingsMask");
    const msg = $("#setMsg");
    const setMsg = (text, ok) => { msg.textContent = text || ""; msg.className = "set-msg" + (ok ? " ok" : text ? " err" : ""); };
    const open = async () => {
      mask.classList.remove("hidden");
      setMsg("");
      $("#setApiKey").value = "";
      try {
        const j = await fetch("/api/config").then(r => r.json());
        $("#setBaseUrl").value = j.baseUrl || "";
        $("#setModel").value = j.model || "";
        const ks = $("#keyState");
        if (j.hasKey) {
          const src = j.keySource === "file" ? "本机配置" : j.keySource === "env" ? "环境变量" : j.keySource === "legacy" ? "旧版 .ark-key" : "";
          ks.textContent = `已配置 API Key（${j.keyMask}）· 来源：${src}`;
          ks.className = "key-state ok";
        } else {
          ks.textContent = "尚未配置 API Key";
          ks.className = "key-state err";
        }
      } catch {
        setMsg("无法读取服务端配置（需通过本地服务访问，不能直接双击打开 HTML）", false);
      }
    };
    const close = () => mask.classList.add("hidden");
    $("#btnSettings").onclick = open;
    $("#btnSettingsClose").onclick = close;
    mask.onclick = (e) => { if (e.target === mask) close(); };

    const collect = () => ({
      baseUrl: $("#setBaseUrl").value.trim(),
      model: $("#setModel").value.trim(),
      apiKey: $("#setApiKey").value.trim(),
    });

    $("#btnSaveSettings").onclick = async () => {
      const c = collect();
      if (!c.baseUrl || !c.model) return setMsg("接口地址和模型名称不能为空", false);
      setMsg("正在保存…", true);
      try {
        const j = await fetch("/api/config/save", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(c),
        }).then(r => r.json());
        if (j.error) return setMsg(j.error, false);
        $("#setApiKey").value = "";
        setMsg("已保存，识别将使用新配置", true);
        this.checkConfig();
        const ks = $("#keyState");
        if (j.hasKey) { ks.textContent = `已配置 API Key（${j.keyMask}）`; ks.className = "key-state ok"; }
      } catch (e) { setMsg("保存失败：" + e.message, false); }
    };

    $("#btnClearKey").onclick = async () => {
      setMsg("正在清除…", true);
      try {
        const j = await fetch("/api/config/save", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clearKey: true }),
        }).then(r => r.json());
        $("#setApiKey").value = "";
        const ks = $("#keyState");
        ks.textContent = j.hasKey ? `仍有可用 Key（${j.keyMask}，来自环境变量/旧文件）` : "已清除本机保存的 API Key";
        ks.className = j.hasKey ? "key-state ok" : "key-state err";
        setMsg("已操作", true);
        this.checkConfig();
      } catch (e) { setMsg("清除失败：" + e.message, false); }
    };

    $("#btnConnTest").onclick = async () => {
      const c = collect();
      if (!c.baseUrl || !c.model) return setMsg("接口地址和模型名称不能为空", false);
      setMsg("正在向模型发送测试请求（约 5~15 秒）…", true);
      try {
        const j = await fetch("/api/config/test", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(c),
        }).then(r => r.json());
        if (j.ok) setMsg(`连接成功 ✓ 模型 ${j.model} 响应 ${j.elapsed}s`, true);
        else setMsg(j.error || "连接失败", false);
      } catch (e) { setMsg("连接失败：" + e.message, false); }
    };
  }

  // ---------------- 导入方案 JSON ----------------
  bindImport() {
    const ji = $("#jsonInput");
    $("#btnImportJson").onclick = () => ji.click();
    ji.onchange = () => {
      const f = ji.files[0];
      ji.value = "";
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const plan = JSON.parse(reader.result);
          if (!plan || !Array.isArray(plan.walls)) throw new Error("文件中缺少 walls 数据");
          this.openPlan(plan);
          if (plan.image) this.view2d.setBgImage(plan.image);
          toast(`已导入方案「${plan.name || "未命名"}」`);
        } catch (e) { toast("导入失败：" + e.message, 4000); }
      };
      reader.readAsText(f);
    };
  }

  // ---------------- 最近方案（localStorage） ----------------
  get RECENT_KEY() { return "floorplan3d_recents_v1"; }
  loadRecents() {
    try { return JSON.parse(localStorage.getItem(this.RECENT_KEY) || "[]"); } catch { return []; }
  }
  saveRecent(plan) {
    if (!plan || !Array.isArray(plan.walls) || plan.walls.length === 0) return;
    try {
      const rec = JSON.parse(JSON.stringify(plan));
      // 超大 dataURL 底图不入存储，避免超出 localStorage 配额
      if (rec.image && typeof rec.image === "string" && rec.image.startsWith("data:") && rec.image.length > 600000) {
        rec.image = null; rec.imgRect = null; rec.imgRect0 = null;
      }
      let rid = plan._rid;
      if (!rid) { rid = "r" + Date.now() + Math.floor(Math.random() * 1000); Object.defineProperty(plan, "_rid", { value: rid, enumerable: false, configurable: true }); }
      const area = (rec.rooms || []).reduce((s, r) => s + (r.areaM2 || 0), 0);
      const item = {
        rid, ts: Date.now(), name: rec.name || "未命名方案",
        walls: rec.walls.length, doors: (rec.doors || []).length,
        windows: (rec.windows || []).length,
        furn: (rec.furniture || []).length,
        area: Math.round(area), plan: rec,
      };
      let list = this.loadRecents().filter(r => r.rid !== rid);
      list.unshift(item);
      list = list.slice(0, 6);
      try { localStorage.setItem(this.RECENT_KEY, JSON.stringify(list)); }
      catch { // 配额不足时丢弃底图再试一次
        list.forEach(i => { i.plan.image = null; i.plan.imgRect = null; i.plan.imgRect0 = null; });
        localStorage.setItem(this.RECENT_KEY, JSON.stringify(list));
      }
      if (!$("#home").classList.contains("hidden")) this.renderRecents();
    } catch { /* 存储不可用时静默 */ }
  }
  fmtTime(ts) {
    const d = Date.now() - ts;
    if (d < 60000) return "刚刚";
    if (d < 3600000) return Math.floor(d / 60000) + " 分钟前";
    if (d < 86400000) return Math.floor(d / 3600000) + " 小时前";
    const dt = new Date(ts);
    return `${dt.getMonth() + 1}月${dt.getDate()}日`;
  }
  renderRecents() {
    const wrap = $("#recentWrap"), box = $("#recentList");
    if (!wrap || !box) return;
    const list = this.loadRecents();
    if (!list.length) { wrap.classList.add("hidden"); return; }
    wrap.classList.remove("hidden");
    box.innerHTML = "";
    list.forEach(r => {
      const b = document.createElement("button");
      b.className = "recent-item";
      const parts = [`墙 ${r.walls} · 门 ${r.doors} · 窗 ${r.windows}`];
      if (r.furn) parts.push(`家具 ${r.furn}`);
      if (r.area) parts.push(`约 ${r.area.toFixed(0)}㎡`);
      b.innerHTML =
        `<span class="ri-ico">📐</span>` +
        `<span class="ri-main"><span class="ri-name"></span><span class="ri-meta">${parts.join(" · ")} · ${this.fmtTime(r.ts)}</span></span>` +
        `<span class="ri-del" title="删除">✕</span>`;
      b.querySelector(".ri-name").textContent = r.name;
      b.onclick = (e) => {
        if (e.target.closest(".ri-del")) return;
        const plan = r.plan;
        Object.defineProperty(plan, "_rid", { value: r.rid, enumerable: false, configurable: true });
        this.openPlan(plan);
        if (plan.image) this.view2d.setBgImage(plan.image);
        else this.view2d.setBgImage(null);
        toast("已打开最近方案：" + r.name);
      };
      b.querySelector(".ri-del").onclick = (e) => {
        e.stopPropagation();
        const rest = this.loadRecents().filter(x => x.rid !== r.rid);
        localStorage.setItem(this.RECENT_KEY, JSON.stringify(rest));
        this.renderRecents();
      };
      box.appendChild(b);
    });
    $("#btnClearRecent").onclick = () => {
      localStorage.removeItem(this.RECENT_KEY);
      this.renderRecents();
      toast("已清空最近方案");
    };
  }

  async loadSample1() {
    // 用真实识别过的 JSON 走 aiToPlan，离线也能演示 AI 结果
    try {
      const j = await fetch("assets/sample1.json").then(r => r.json());
      const img = await loadImage("assets/sample1.png");
      const plan = aiToPlan(j, img.naturalWidth, img.naturalHeight, "assets/sample1.png");
      plan.name = "一室一厅（AI 识别示例）";
      this.openPlan(plan);
      this.view2d.setBgImage("assets/sample1.png");
      toast("已载入 AI 识别示例，可在 2D 校图中修改");
    } catch (e) { toast("示例加载失败：" + e.message); }
  }

  async handleFile(file) {
    if (file.size > 20 * 1024 * 1024) return toast("图片不能超过 20MB");
    const dataUrl = await fileToDataUrl(file);
    const img = await loadImage(dataUrl);
    const thinking = $("#optThinking").checked;
    this.showRec(true, thinking);
    try {
      setStage(20, "图片已读取，调用 AI 识别…");
      const t0 = Date.now();
      const { raw, elapsed } = await recognize(dataUrl, thinking, (s) => setStage(55, s));
      setStage(85, "识别完成，正在生成户型几何…");
      const plan = aiToPlan(raw, img.naturalWidth, img.naturalHeight, dataUrl);
      plan.name = file.name.replace(/\.[^.]+$/, "").slice(0, 24) || "AI 识别户型";
      this.openPlan(plan);
      this.view2d.setBgImage(dataUrl);
      setStage(100, "完成");
      const n = `墙${plan.walls.length}/门${plan.doors.length}/窗${plan.windows.length}/房间${plan.rooms.length}`;
      toast(`识别完成（${elapsed || Math.round((Date.now()-t0)/1000)}s）：${n}。请在 2D 校图中核对，再点「生成 3D」`, 5200);
    } catch (e) {
      toast("识别失败：" + e.message + "。可改用示例或手动画墙", 6000);
    } finally {
      this.showRec(false);
    }
  }

  showRec(show, thinking) {
    $("#recognizing").classList.toggle("hidden", !show);
    if (show) {
      $("#recTitle").textContent = thinking ? "AI 精修识别中（约 2~4 分钟）…" : "AI 正在识别户型…";
      $("#recStep").textContent = thinking ? "复杂图纸深度推理，请勿关闭页面" : "快速模式约 20 秒";
      $("#recHint").textContent = thinking ? "💡 可以先去喝杯水，完成后自动进入编辑器" : "💡 识别后可在 2D 校图页手动修正";
      setStage(10, "上传图片中…");
    }
  }

  openPlan(plan) {
    $("#home").classList.add("hidden");
    $("#editor").classList.remove("hidden");
    $("#planName").value = plan.name;
    this.store.load(plan);
    if (plan.image && plan.imgRect && !plan.imgRect0) plan.imgRect0 = { ...plan.imgRect };
    requestAnimationFrame(() => { this.view2d._fitted = false; this.view2d.fit(); this.view2d.draw(); this.view3d.resize(); this.view3d.frameView(); });
    this.setView("2d");
    this.renderRoomList();
  }

  // ---------------- 顶栏 ----------------
  bindTopbar() {
    $("#btnHome").onclick = () => { $("#editor").classList.add("hidden"); $("#home").classList.remove("hidden"); this.renderRecents(); };
    $("#planName").oninput = (e) => this.store.plan.name = e.target.value;
    $$("[data-view]").forEach(b => b.onclick = () => {
      if (b.dataset.view === "walk") { this.setView("walk"); this.view3d.viewEye(); }
      else this.setView(b.dataset.view);
    });
    $("#btnBuild").onclick = () => { this.view3d.build(); this.setView("3d"); toast("3D 已按最新户型刷新"); };
    $("#btnUndo").onclick = () => this.store.undo();
    $("#btnRedo").onclick = () => this.store.redo();
    $("#btnSun").onclick = () => this.view3d.setNight(false);
    $("#btnNight").onclick = () => this.view3d.setNight(true);
    $("#btnTop").onclick = () => this.view3d.viewTop();
    $("#btnEye").onclick = () => this.view3d.viewEye();
    $("#btnCeil").onclick = () => this.view3d.toggleCeiling();

    // 2D 工具
    $$(".canvas-tools [data-tool]").forEach(b => b.onclick = () => {
      $$(".canvas-tools [data-tool]").forEach(x => x.classList.remove("active"));
      b.classList.add("active");
      this.view2d.setTool(b.dataset.tool);
      $("#toolHint").textContent = TOOL_HINTS[b.dataset.tool] || "";
    });
    $("#toggleBg").onchange = (e) => { this.view2d.showBg = e.target.checked; this.view2d.draw(); };
    $("#btnFitAll").onclick = () => { this.view2d._fitted = true; this.view2d.fit(); toast("已适应全屋"); };
    $("#btnCalibDefault").onclick = () => toast("可使用顶部「📏 校准」工具：在图上拖一段已知长度并输入毫米数");
    $("#btnBgReset").onclick = () => {
      const p = this.store.plan;
      if (!p.imgRect) return toast("当前方案没有原始底图");
      const base = p.imgRect0 ? { ...p.imgRect0 } : { x: 0, y: 0, w: p.imgRect.w, h: p.imgRect.h };
      this.store.begin();
      p.imgRect = base;
      this.store.commit("底图复位");
      this.view2d.draw();
      toast("原始底图位置已复位");
    };
    $("#btnOrthogonize").onclick = () => {
      const p = this.store.plan;
      // 记录门窗当前世界坐标，墙体重建后重新挂接
      const pts = [];
      for (const d of p.doors) { const w = p.walls.find(z => z.id === d.wallId); if (w) { const L=Math.hypot(w.x2-w.x1,w.y2-w.y1),ux=(w.x2-w.x1)/L,uy=(w.y2-w.y1)/L; pts.push([d, w.x1+ux*d.off, w.y1+uy*d.off]); } }
      for (const win of p.windows) { const w = p.walls.find(z => z.id === win.wallId); if (w) { const L=Math.hypot(w.x2-w.x1,w.y2-w.y1),ux=(w.x2-w.x1)/L,uy=(w.y2-w.y1)/L; pts.push([win, w.x1+ux*win.off, w.y1+uy*win.off]); } }
      this.store.begin();
      cleanupWalls(p, 350);
      for (const [o, x, y] of pts) o.at = [x, y];
      attachOpenings(p);
      this.store.commit("一键方正");
      this.view3d.build(); this.view2d.draw();
      toast("已将墙体强制正交对齐，门窗已自动重挂");
    };
  }

  setView(m) {
    // 漫游和 3D 共用同一个 WebGL 容器；walk 时绝不能 display:none，否则 canvas 尺寸归零会黑屏
    if (m !== "walk" && this.view3d.mode === "walk") this.view3d.exitWalk();
    this.mode = m;
    $("#view2d").classList.toggle("hidden", m !== "2d");
    $("#view3d").classList.toggle("hidden", m === "2d");
    $$("[data-view]").forEach(b => b.classList.toggle("active", b.dataset.view === m));
    $("#leftPanel").classList.toggle("hidden", m === "walk");
    $("#rightPanel").classList.toggle("hidden", m === "walk");
    if (m !== "2d") requestAnimationFrame(() => { this.view3d.resize(); });
    if (m === "2d") requestAnimationFrame(() => this.view2d.draw());
  }

  // ---------------- 左侧：家具/配色/房间 ----------------
  bindLeft() {
    $$("#leftTabs .tab").forEach(t => t.onclick = () => {
      $$("#leftTabs .tab").forEach(x => x.classList.remove("active"));
      t.classList.add("active");
      $$(".tabbody").forEach(b => b.classList.toggle("hidden", b.dataset.tab !== t.dataset.tab));
    });

    // 家具库
    const list = $("#furnList");
    const renderFurn = (q = "") => {
      list.innerHTML = "";
      FURNITURE.filter(f => !q || f.name.includes(q) || f.cat.includes(q)).forEach(f => {
        const c = document.createElement("div");
        c.className = "furn-card"; c.draggable = true;
        c.innerHTML = `<span class="ico">${f.ico}</span><span class="nm">${f.name}<br><small>${f.cat} ${f.w}×${f.d}</small></span>`;
        c.ondragstart = (e) => { e.dataTransfer.setData("text/furn", f.type); this._dragFurn = f.type; };
        c.ondblclick = () => this.addFurnitureAtCenter(f.type);
        c.onclick = () => this.addFurnitureAtCenter(f.type);
        list.appendChild(c);
      });
    };
    renderFurn();
    $("#furnSearch").oninput = (e) => renderFurn(e.target.value.trim());

    // 拖到 3D 视窗
    const cv3 = $("#canvas3d");
    cv3.addEventListener("dragover", e => e.preventDefault());
    cv3.addEventListener("drop", (e) => {
      e.preventDefault();
      const type = e.dataTransfer.getData("text/furn") || this._dragFurn;
      if (!type) return;
      const pt = this.view3d.groundAt(e);
      this.store.begin();
      const f = makeFurniture(type);
      f.x = pt ? Math.round(pt.x * 1000 / 50) * 50 : 0;
      f.y = pt ? Math.round(pt.z * 1000 / 50) * 50 : 0;
      this.store.plan.furniture.push(f);
      this.store.commit("添加家具");
      this.view3d.selFurn = f.id;
      this.setSel({ kind: "furniture", id: f.id });
    });
    // 拖到 2D canvas 时切到 2D（简化：双击/单击卡片即放中心，也够用）
    $("#canvas2d").addEventListener("dragover", e => e.preventDefault());
    $("#canvas2d").addEventListener("drop", (e) => {
      e.preventDefault();
      const type = e.dataTransfer.getData("text/furn") || this._dragFurn;
      if (type) this.addFurnitureAtCenter(type);
    });

    // 配色
    const sw = $("#wallColors");
    WALL_COLORS.forEach(c => {
      const b = document.createElement("div"); b.className = "swatch"; b.style.background = c;
      b.title = c; b.onclick = () => { this.store.begin(); this.store.plan.wallColor = c; this.store.commit("墙面换色"); this.view3d.build(); };
      sw.appendChild(b);
    });
    const fm = $("#floorMats");
    FLOOR_MATS.forEach(m => {
      const b = document.createElement("div"); b.className = "mat-chip";
      b.innerHTML = `<div class="sw" style="background:${m.c}"></div>${m.name}`;
      b.onclick = () => {
        const roomId = this.sel?.kind === "room" ? this.sel.id : null;
        this.store.begin();
        this.store.plan.rooms.forEach(r => { if (!roomId || r.id === roomId) r.floorColor = m.c; });
        this.store.commit("地面材质"); this.view3d.build(); this.view2d.draw();
      };
      fm.appendChild(b);
    });
    const tl = $("#themeList");
    THEMES.forEach(t => {
      const b = document.createElement("div"); b.className = "theme-card";
      b.innerHTML = `<div class="theme-strip">${t.sw.map(c => `<i style="flex:1;background:${c}"></i>`).join("")}</div><span>${t.name}</span>`;
      b.onclick = () => this.applyTheme(t);
      tl.appendChild(b);
    });

    // 涂刷对象快捷
    const mt = $("#matTargets");
    [["全屋墙面", "wall"], ["全屋地面", "floor"], ["天花", "ceil"]].forEach(([nm, k]) => {
      const b = document.createElement("button"); b.className = "btn mini"; b.textContent = nm;
      b.onclick = () => toast(k === "wall" ? "在下方点选墙漆颜色（作用于全屋墙面）" : k === "floor" ? "在下方点选地面材质" : "天花默认白色，可在右侧属性调整");
      mt.appendChild(b);
    });
  }

  applyTheme(t) {
    this.store.begin();
    const p = this.store.plan;
    p.wallColor = t.wall;
    p.rooms.forEach((r, i) => r.floorColor = t.floors[i % t.floors.length]);
    p.furniture.forEach(f => { if (["sofa","sofa2","armchair","rug","bed","bed15"].includes(f.type)) f.color = t.sw[2]; });
    this.store.commit("应用主题：" + t.name);
    this.view3d.build(); this.view2d.draw();
    toast("已应用主题：" + t.name);
  }

  addFurnitureAtCenter(type) {
    const b = planBounds(this.store.plan);
    this.store.begin();
    const f = makeFurniture(type);
    f.x = Math.round((b.x + b.w / 2) / 50) * 50;
    f.y = Math.round((b.y + b.h / 2) / 50) * 50;
    this.store.plan.furniture.push(f);
    this.store.commit("添加家具");
    this.setSel({ kind: "furniture", id: f.id });
    this.view3d.selFurn = f.id;
  }

  renderRoomList() {
    const list = $("#roomList"); list.innerHTML = "";
    this.store.plan.rooms.forEach(r => {
      const c = document.createElement("div"); c.className = "room-item";
      c.innerHTML = `<span class="dot" style="background:${r.floorColor}"></span><span>${r.name || ROOM_TYPES[r.type] || "房间"}</span><span class="meta">${r.areaM2 ? r.areaM2.toFixed(1) + "㎡" : ""}</span>`;
      c.title = "单击选中房间；双击定位到该房间";
      c.onclick = () => {
        this.setView("2d");
        this.setSel({ kind: "room", id: r.id });
      };
      c.ondblclick = () => requestAnimationFrame(() => {
        if (!this.view2d.fitRoom(r)) requestAnimationFrame(() => this.view2d.fitRoom(r));
      });
      list.appendChild(c);
    });
  }

  // ---------------- 属性面板 ----------------
  setSel(sel) {
    this.sel = sel;
    this.view2d.sel = sel;
    if (sel?.kind === "furniture") this.view3d.selFurn = sel.id;
    this.renderProps();
    this.view2d.draw();
  }

  bindProps() { this.store.onChange(() => { this.renderProps(); this.renderRoomList(); }); }

  field(label, innerHtml) {
    return `<div class="field"><label>${label}</label>${innerHtml}</div>`;
  }

  renderProps() {
    const p = this.store.plan, body = $("#propBody");
    const s = this.sel;
    if (!s) {
      body.innerHTML = `<div class="prop-empty">
        <b>全局设置</b><br>
        点击 2D 中的墙/门/窗/房间/家具，或 3D 中的家具可编辑属性。<br><br>
        当前：墙 ${p.walls.length} · 门 ${p.doors.length} · 窗 ${p.windows.length} · 房间 ${p.rooms.length} · 家具 ${p.furniture.length}<br>
        比例来源：${p.scaleSource || "—"}
        ${p.aiNotes ? "<br><br>📝 AI 备注：" + esc(p.aiNotes) : ""}
      </div>` +
      this.field("层高 (mm)", `<input type="number" id="pWallH" value="${p.wallHeight}" step="50">`) +
      this.field("墙面颜色", `<input type="color" id="pWallC" value="${p.wallColor}">`) +
      this.field("天花颜色", `<input type="color" id="pCeilC" value="${p.ceilColor}">`) +
      `<button class="btn block" id="pRebuild">应用并刷新 3D</button>`;
      $("#pWallH")?.addEventListener("input", e => { p.wallHeight = +e.target.value || 2800; });
      $("#pWallC")?.addEventListener("input", e => { p.wallColor = e.target.value; this.view3d.build(); });
      $("#pCeilC")?.addEventListener("input", e => { p.ceilColor = e.target.value; this.view3d.build(); });
      $("#pRebuild")?.addEventListener("click", () => this.view3d.build());
      return;
    }

    if (s.kind === "wall") {
      const w = p.walls.find(x => x.id === s.id); if (!w) return this.setSel(null);
      const L = Math.round(Math.hypot(w.x2 - w.x1, w.y2 - w.y1));
      body.innerHTML =
        this.field("类型", `<select id="pwLoad"><option value="200" ${w.thick===200?"selected":""}>外墙/承重 200</option><option value="100" ${w.thick===100?"selected":""}>内墙 100</option></select>`) +
        this.field("长度 (mm)", `<input type="number" value="${L}" disabled>`) +
        this.field("起点 X/Y", `<div class="field-row"><input type="number" id="pwX1" value="${Math.round(w.x1)}"><input type="number" id="pwY1" value="${Math.round(w.y1)}"></div>`) +
        this.field("终点 X/Y", `<div class="field-row"><input type="number" id="pwX2" value="${Math.round(w.x2)}"><input type="number" id="pwY2" value="${Math.round(w.y2)}"></div>`) +
        `<button class="btn block danger" id="pwDel">删除此墙（含其门窗）</button>`;
      const commit = () => { this.store.begin(); w.thick = +$("#pwLoad").value; w.load = w.thick === 200;
        w.x1 = +$("#pwX1").value; w.y1 = +$("#pwY1").value; w.x2 = +$("#pwX2").value; w.y2 = +$("#pwY2").value; this.store.commit("墙体编辑"); this.view3d.build(); };
      ["pwLoad","pwX1","pwY1","pwX2","pwY2"].forEach(id => $("#"+id).addEventListener("change", commit));
      $("#pwDel").onclick = () => { this.store.begin(); p.walls = p.walls.filter(x => x.id !== w.id); p.doors = p.doors.filter(d => d.wallId !== w.id); p.windows = p.windows.filter(z => z.wallId !== w.id); this.store.commit("删墙"); this.setSel(null); this.view3d.build(); };
    }
    else if (s.kind === "door") {
      const d = p.doors.find(x => x.id === s.id); if (!d) return this.setSel(null);
      body.innerHTML =
        this.field("门型", `<select id="pdKind"><option value="swing" ${d.kind==="swing"?"selected":""}>平开门</option><option value="sliding" ${d.kind==="sliding"?"selected":""}>推拉门</option></select>`) +
        this.field("宽度 (mm)", `<input type="number" id="pdW" value="${d.width}" step="50">`) +
        this.field("合页侧", `<select id="pdH"><option value="left" ${d.hingeSide==="left"?"selected":""}>左</option><option value="right" ${d.hingeSide==="right"?"selected":""}>右</option></select>`) +
        this.field("开启方向", `<select id="pdI"><option value="true" ${d.inward?"selected":""}>向内</option><option value="false" ${!d.inward?"selected":""}>向外</option></select>`) +
        this.field("开启角度", `<input type="range" id="pdO" min="0" max="100" value="${d.open}">`) +
        `<button class="btn block danger" id="pdDel">删除门</button>`;
      const commit = () => { this.store.begin(); d.kind = $("#pdKind").value; d.width = +$("#pdW").value; d.hingeSide = $("#pdH").value; d.inward = $("#pdI").value === "true"; d.open = +$("#pdO").value; this.store.commit("门编辑"); this.view3d.build(); };
      ["pdKind","pdW","pdH","pdI","pdO"].forEach(id => $("#"+id).addEventListener("input", commit));
      $("#pdDel").onclick = () => { this.store.begin(); p.doors = p.doors.filter(x => x.id !== d.id); this.store.commit("删门"); this.setSel(null); this.view3d.build(); };
    }
    else if (s.kind === "window") {
      const w = p.windows.find(x => x.id === s.id); if (!w) return this.setSel(null);
      body.innerHTML =
        this.field("窗型", `<select id="pwiK"><option ${w.kind==="normal"?"selected":""}>normal</option><option value="bay" ${w.kind==="bay"?"selected":""}>飘窗</option><option value="floor" ${w.kind==="floor"?"selected":""}>落地窗</option></select>`) +
        this.field("宽度 (mm)", `<input type="number" id="pwiW" value="${Math.round(w.width)}" step="50">`) +
        this.field("窗台高 (mm)", `<input type="number" id="pwiS" value="${w.sill}" step="50">`) +
        this.field("窗高 (mm)", `<input type="number" id="pwiH" value="${w.height}" step="50">`) +
        `<button class="btn block danger" id="pwiDel">删除窗</button>`;
      const commit = () => { this.store.begin(); w.kind = $("#pwiK").value; w.width = +$("#pwiW").value; w.sill = +$("#pwiS").value; w.height = +$("#pwiH").value; this.store.commit("窗编辑"); this.view3d.build(); };
      ["pwiK","pwiW","pwiS","pwiH"].forEach(id => $("#"+id).addEventListener("change", commit));
      $("#pwiDel").onclick = () => { this.store.begin(); p.windows = p.windows.filter(x => x.id !== w.id); this.store.commit("删窗"); this.setSel(null); this.view3d.build(); };
    }
    else if (s.kind === "room") {
      const r = p.rooms.find(x => x.id === s.id); if (!r) return this.setSel(null);
      body.innerHTML =
        this.field("房间名", `<input type="text" id="prN" value="${esc(r.name)}">`) +
        this.field("功能", `<select id="prT">${Object.entries(ROOM_TYPES).map(([k,v]) => `<option value="${k}" ${r.type===k?"selected":""}>${v}</option>`).join("")}</select>`) +
        this.field("地面颜色", `<input type="color" id="prC" value="${rgbHex(r.floorColor)}">`) +
        this.field("面积", `<input type="text" value="${r.areaM2 ? r.areaM2.toFixed(1)+' ㎡（自动）' : '自动'}" disabled>`);
      $("#prN").oninput = () => { r.name = $("#prN").value; this.view2d.draw(); };
      $("#prT").onchange = () => { this.store.begin(); r.type = $("#prT").value; this.store.commit("房间类型"); };
      $("#prC").oninput = () => { r.floorColor = $("#prC").value; this.view3d.build(); this.view2d.draw(); };
    }
    else if (s.kind === "furniture") {
      const f = p.furniture.find(x => x.id === s.id); if (!f) return this.setSel(null);
      const def = getFurnitureDef(f.type);
      body.innerHTML =
        `<div class="prop-sec">${def.ico} ${esc(f.name)}</div>` +
        this.field("位置 X / Y (mm)", `<div class="field-row"><input type="number" id="pfX" value="${Math.round(f.x)}" step="50"><input type="number" id="pfY" value="${Math.round(f.y)}" step="50"></div>`) +
        this.field("旋转角 (°)", `<input type="number" id="pfR" value="${Math.round(f.rot*180/Math.PI)}" step="15">`) +
        this.field("长度 X (mm)", `<input type="number" id="pfW" value="${Math.round(def.w*f.sx)}" step="10" min="100">`) +
        this.field("进深 Y (mm)", `<div class="field-row"><input type="number" id="pfD" value="${Math.round(def.d*f.sy)}" step="10" min="100"></div>`) +
        this.field("高度 Z (mm)", `<input type="number" id="pfH" value="${Math.round(def.h*f.sz)}" step="10" min="100">`) +
        this.field("颜色", `<input type="color" id="pfC" value="${rgbHex(f.color || def.color)}">`) +
        this.field("离地 (mm)", `<input type="number" id="pfE" value="${f.elev||0}" step="50">`) +
        `<button class="btn block" id="pfResetSize">↩ 恢复默认尺寸（${def.w}×${def.d}×${def.h}mm）</button>` +
        `<button class="btn block" id="pfDup">📋 复制一件</button>` +
        `<button class="btn block danger" id="pfDel">删除家具</button>` +
        `<p class="prop-sec" style="border:none;padding-top:4px">2D 选中后拖蓝色圆点改长宽；3D 中 Q/E 旋转、R/F 整体缩放</p>`;
      const apply = (commit) => {
        if (commit) this.store.begin();
        f.x = +$("#pfX").value; f.y = +$("#pfY").value;
        f.rot = +$("#pfR").value * Math.PI / 180;
        const clampScale = v => Math.max(0.2, Math.min(5, v));
        f.sx = clampScale((+$("#pfW").value || def.w) / def.w);
        f.sy = clampScale((+$("#pfD").value || def.d) / def.d);
        f.sz = clampScale((+$("#pfH").value || def.h) / def.h);
        f.color = $("#pfC").value; f.elev = +$("#pfE").value || 0;
        if (commit) { this.store.commit("家具属性"); this.view3d.build(); }
        this.view2d.draw();
      };
      ["pfX","pfY","pfR","pfW","pfD","pfH","pfE"].forEach(id => $("#"+id).addEventListener("change", () => apply(true)));
      $("#pfC").addEventListener("input", () => apply(false));
      $("#pfResetSize").onclick = () => {
        this.store.begin(); f.sx = f.sy = f.sz = 1; this.store.commit("恢复家具尺寸");
        this.view3d.build(); this.view2d.draw();
      };
      $("#pfDup").onclick = () => { this.store.begin(); const n = JSON.parse(JSON.stringify(f)); n.id = uid("f"); n.x += 400; n.y += 400; p.furniture.push(n); this.store.commit("复制家具"); this.setSel({kind:"furniture",id:n.id}); this.view3d.build(); };
      $("#pfDel").onclick = () => { this.store.begin(); p.furniture = p.furniture.filter(x => x.id !== f.id); this.store.commit("删家具"); this.setSel(null); this.view3d.build(); };
    }
  }

  // ---------------- 导出 ----------------
  bindExport() {
    const menu = $("#exportMenu");
    $("#btnExport").onclick = (e) => { e.stopPropagation(); menu.classList.toggle("hidden"); };
    document.addEventListener("click", () => menu.classList.add("hidden"));
    menu.onclick = (e) => e.stopPropagation();
    $$("#exportMenu button").forEach(b => b.onclick = async () => {
      const kind = b.dataset.exp, name = (this.store.plan.name || "户型").replace(/[\\/:*?"<>|]/g, "_");
      menu.classList.add("hidden");
      try {
        if (kind === "png") { await exportPNGFromSVG(this.store.plan, `${name}-户型图.png`, false, 0.5); toast("已导出修改后户型图 PNG"); }
        if (kind === "pngbg") { await exportPNGFromSVG(this.store.plan, `${name}-户型图_叠加原图.png`, true, 0.5); toast("已导出叠加原图的户型图 PNG"); }
        if (kind === "svg") { exportSVG(this.store.plan, `${name}-户型图.svg`, false); toast("已导出矢量 SVG"); }
        if (kind === "json") { downloadJSON(this.store.plan, `${name}-方案.json`); toast("已导出方案 JSON（可备份/再导入）"); }
        if (kind === "shot") {
          if (this.mode !== "3d") this.setView("3d");
          await new Promise(r => setTimeout(r, 300));
          const url = this.view3d.screenshot();
          const a = document.createElement("a"); a.href = url; a.download = `${name}-3D截图.png`; a.click();
          toast("已导出 3D 截图");
        }
      } catch (e) { toast("导出失败：" + e.message, 4000); }
    });
  }

  // ---------------- 快捷键 ----------------
  bindKeys() {
    window.addEventListener("keydown", (e) => {
      if ($("#editor").classList.contains("hidden")) return;
      const tag = e.target.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? this.store.redo() : this.store.undo(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { e.preventDefault(); this.store.redo(); }
      if (e.key === "Escape" && this.view3d.mode === "walk") this.view3d.exitWalk();
      if (e.key === "Delete" || e.key === "Backspace") {
        const s = this.sel; if (!s) return;
        const map = { wall: "walls", door: "doors", window: "windows", furniture: "furniture", room: "rooms" };
        const arr = this.store.plan[map[s.kind]]; if (!arr) return;
        this.store.begin();
        const idx = arr.findIndex(x => x.id === s.id);
        if (idx >= 0) arr.splice(idx, 1);
        if (s.kind === "wall") { this.store.plan.doors = this.store.plan.doors.filter(d => d.wallId !== s.id); this.store.plan.windows = this.store.plan.windows.filter(w => w.wallId !== s.id); }
        this.store.commit("删除"); this.setSel(null); this.view3d.build();
      }
    });
  }
}

const TOOL_HINTS = {
  select: "点选后拖动；选中端点可拉墙；右键/中键拖画布，滚轮缩放",
  wall: "点击两点画墙（Shift 连画且正交，Alt 画承重墙），Esc 取消",
  door: "在靠近墙的位置点击放门，随后在右侧改门型/开向",
  window: "在靠近墙的位置点击放窗",
  calib: "拖出一段已知实际长度的线，输入毫米数，全屋等比校准",
  bgmove: "按住并拖动原始户型图，仅移动底图用于和识别墙体对齐；墙体不会移动",
  erase: "点击墙/门/窗/家具删除（也可选中后按 Delete）",
};

function setStage(pct, text) {
  $("#recBar").style.width = pct + "%";
  $("#recStep").textContent = text;
}
function esc(s) { return String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function rgbHex(c) {
  if (!c) return "#cccccc";
  if (c.startsWith("#")) return c.length === 7 ? c : "#cccccc";
  const m = c.match(/\d+/g); if (!m || m.length < 3) return "#cccccc";
  return "#" + m.slice(0, 3).map(n => (+n).toString(16).padStart(2, "0")).join("");
}

window.addEventListener("DOMContentLoaded", () => window.app = new App());