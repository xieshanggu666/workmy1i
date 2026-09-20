/**
 * FG.Blueprint —— 蓝图：框选捕获、旋转、成本汇总、科技/地形校验、原地升级扫描
 * FG.Construction —— 施工调度：计划优先级 × 前置依赖 × 全局建材统一分配
 *
 * 调度模型（每 tick 一轮）：
 *  - 先盘点全图「自由建材」（箱子→地面物料堆）构成统一预算池，所有计划共享；
 *  - 计划可设高/中/低优先级与前置依赖：高优先级一层未取料前低优先级不分配，
 *    同级按轮转游标公平起步；前置计划未完成（仍在列表中）时本计划挂起、不占料；
 *  - 每个计划按蓝图顺序找「前沿条目」：尽量从预算池预留其缺口建材（可部分预留，
 *    预留即移出物流）；前沿凑不齐时，向后找一栋「当前能一次凑齐整套成本」的条目
 *    直接建成 —— 即缺料时推进可施工部分；
 *  - 建材凑齐且施工间隔到期 → 消耗预留、落成建筑（map/sim 注册 + 配方/筛选/优先级
 *    还原），自动纳入每 tick 的按需物流调度；
 *  - 原地升级条目（entry.upgrade={from}）：备料完成前旧建筑照常生产，切换 tick 才
 *    在同一格换型，配方/槽位库存/带面在途物品（含预留标签）/机械臂手持/流体全部
 *    直接保留，不落地、不掉预留；
 *  - 暂停计划 / 等待前置 / 取消计划：已预留建材立即返还物流（优先箱子，余下落地），
 *    已建成建筑保留、未切换的旧建筑继续运行；前置计划被取消视为依赖自动满足；
 *  - 预留按条目记账，计划整体序列化（含优先级/依赖/暂停态/条目预留），读档续建；
 *    旧存档的计划级 stock 迁移到前沿条目，无施工字段的旧档回退空计划。
 */
FG.Blueprint = (() => {

  /** 框选捕获：把矩形区域内的建筑存为相对坐标蓝图（含配方/筛选/按需/优先级） */
  function capture(map, x0, y0, x1, y1) {
    const minX = Math.min(x0, x1), maxX = Math.max(x0, x1);
    const minY = Math.min(y0, y1), maxY = Math.max(y0, y1);
    const entries = [];
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const b = map.buildingAt(x, y);
        if (!b) continue;
        entries.push({
          type: b.type, dx: x - minX, dy: y - minY, dir: b.dir || 0,
          recipe: b.recipe || null,
          filter: b.filter || null,
          demandMode: !!b.demandMode,
          priority: b.priority || 'normal',
          stationName: b.stationName || null,
        });
      }
    }
    return { w: maxX - minX + 1, h: maxY - minY + 1, entries };
  }

  /** 顺时针旋转 90°：条目坐标与朝向同步旋转（require 资源约束一并保留） */
  function rotate(bp) {
    return {
      w: bp.h, h: bp.w,
      fromPreset: bp.fromPreset || null,
      entries: bp.entries.map(e => ({
        type: e.type, dx: bp.h - 1 - e.dy, dy: e.dx, dir: ((e.dir || 0) + 1) % 4,
        recipe: e.recipe || null,
        filter: e.filter || null,
        demandMode: !!e.demandMode,
        priority: e.priority || 'normal',
        stationName: e.stationName || null,
        require: e.require ? Object.assign({}, e.require) : undefined,
      })),
    };
  }

  /** 蓝图建材总成本 {item: n} */
  function costOf(bp) {
    const total = {};
    for (const e of bp.entries) {
      const c = FG.Buildings.costOf(e.type);
      for (const k of Object.keys(c)) total[k] = (total[k] || 0) + c[k];
    }
    return total;
  }

  /**
   * 放置校验（科技 + 配方 + 地形/占用 + 资源约束 + 施工计划占格）：
   * 返回 { ok, reason, cells:[{x,y,ok,reason}] }，cells 与 entries 同序（预览着色用）。
   * 一键流水线预设可在条目上带 require：
   *   require.terrain='ore'   须为矿脉格（oreType 指定矿种时还须矿种相符）
   *   require.terrain='water' 水泵：陆地格且四邻有水域
   *   require.terrain='oil'   须为油田格
   */
  function validate(game, bp, ox, oy) {
    const cells = [];
    let ok = true;
    const locked = new Set();
    const lockedRecipes = new Set();
    let blocked = 0, badOre = 0, noWater = 0, noOil = 0;
    for (const e of bp.entries) {
      const x = ox + e.dx, y = oy + e.dy;
      let cok = true, reason = '';
      if (!game.research.isBuildingUnlocked(e.type)) {
        cok = false; reason = 'tech';
        locked.add(FG.Buildings.byId(e.type).name);
      } else if (e.recipe && !game.research.isRecipeUnlocked(e.recipe)) {
        cok = false; reason = 'tech';
        lockedRecipes.add(FG.Recipes.byId(e.recipe).name);
      } else if (e.require && e.require.terrain === 'ore') {
        // 矿机：目标格必须是（指定种类的）矿脉
        const ore = game.map.inBounds(x, y) ? game.map.oreAt(x, y) : null;
        if (!ore) { cok = false; reason = 'terrain'; badOre++; }
        else if (e.require.oreType && ore !== e.require.oreType) { cok = false; reason = 'oretype'; badOre++; }
        else if (game.map.isOccupied(x, y) || (game.construction && game.construction.entryAt(x, y))) {
          cok = false; reason = 'terrain'; blocked++;
        }
      } else if (e.require && e.require.terrain === 'water') {
        // 水泵：陆地（非水面）且四邻有水域
        const landOK = game.map.inBounds(x, y) && game.map.terrainAt(x, y) !== 'water';
        if (!landOK || !game.adjacentWater(x, y)) {
          cok = false; reason = 'terrain'; noWater++;
        } else if (game.map.isOccupied(x, y) || (game.construction && game.construction.entryAt(x, y))) {
          cok = false; reason = 'terrain'; blocked++;
        }
      } else if (e.require && e.require.terrain === 'oil') {
        if (!game.map.isOil(x, y) || game.map.isOccupied(x, y)
            || (game.construction && game.construction.entryAt(x, y))) {
          cok = false; reason = 'terrain'; noOil++;
        }
      } else if (!game.canPlace(e.type, x, y)) {
        cok = false; reason = 'terrain'; blocked++;
      } else if (game.construction && game.construction.entryAt(x, y)) {
        cok = false; reason = 'planned'; blocked++;
      }
      if (!cok) ok = false;
      cells.push({ x, y, ok: cok, reason });
    }
    let msg = '';
    if (locked.size || lockedRecipes.size) {
      msg = '科技未解锁：' + Array.from(locked).concat(Array.from(lockedRecipes)).join('、');
    } else if (badOre) msg = badOre + ' 个矿机位未对准矿脉（矿机需落在对应矿脉上）';
    else if (noWater) msg = noWater + ' 个水泵位无效（需在陆地上且紧邻水域）';
    else if (noOil) msg = noOil + ' 个抽油机位未对准油田';
    else if (blocked) msg = blocked + ' 个位置被占用 / 地形不符 / 已有施工计划';
    return { ok, reason: msg, cells };
  }

  // ================= 原地升级 =================
  /** 某建筑当前可升级到的目标类型（已解锁的同链最高档；无则 null） */
  function upgradeTargetFor(game, b) {
    if (!b || b.isTrain) return null;
    return FG.Buildings.upgradeTargetOf(b.type, (t) => game.research.isBuildingUnlocked(t));
  }

  /**
   * 框选区域原地升级扫描：区域内每栋「存在已解锁高档」的建筑生成一个升级条目，
   * 其余建筑（无升级链 / 高档未解锁 / 同格已有待建计划）忽略，不影响其运行。
   * 返回 { w,h,entries:[{...蓝图条目, fromType}], skipped }，entries 为空表示无可升级项。
   */
  function scanUpgrades(game, x0, y0, x1, y1) {
    const minX = Math.min(x0, x1), maxX = Math.max(x0, x1);
    const minY = Math.min(y0, y1), maxY = Math.max(y0, y1);
    const entries = [];
    let skipped = 0;
    if (!game.map) return { w: maxX - minX + 1, h: maxY - minY + 1, entries, skipped };
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const b = game.map.buildingAt(x, y);
        if (!b) continue;
        const target = upgradeTargetFor(game, b);
        if (!target) { skipped++; continue; }
        // 同格已有待建/待切换条目（可能也是升级）：不重复排产
        if (game.construction && game.construction.entryAt(x, y)) { skipped++; continue; }
        entries.push({
          type: target, dx: x - minX, dy: y - minY, dir: b.dir || 0,
          recipe: b.recipe || null,
          filter: b.filter || null,
          demandMode: !!b.demandMode,
          priority: b.priority || 'normal',
          stationName: b.stationName || null,
          fromType: b.type,
        });
      }
    }
    return { w: maxX - minX + 1, h: maxY - minY + 1, entries, skipped };
  }

  /** 升级蓝图建材净需求汇总（条目结构同普通蓝图，多 fromType） */
  function upgradeCostOf(up) { return costOf({ entries: up.entries }); }

  return {
    capture, rotate, costOf, validate,
    upgradeTargetFor, scanUpgrades, upgradeCostOf,
  };
})();

// ============================================================
FG.Construction = class Construction {
  constructor(game) {
    this.game = game;
    this.plans = [];   // [{id,name,priority,paused,deps:[id],entries:[{...state,stock}],cursor,timer}]
    this.seq = 1;
    this.tierStart = { high: 0, normal: 0, low: 0 }; // 同级轮转起步游标（每 tick）
  }

  /**
   * 提交施工计划：蓝图条目落到世界坐标，进入统一调度队列。
   * opts.upgrade=true 时条目带 fromType，记为原地升级计划（旧建筑保留至切换 tick）。
   */
  addPlan(bp, ox, oy, opts) {
    opts = opts || {};
    const isUpgrade = !!opts.upgrade;
    const plan = {
      id: 'P' + (this.seq++),
      name: isUpgrade
        ? '原地升级 ' + bp.entries.length + ' 栋 #' + (this.seq - 1)
        : '蓝图 ' + bp.w + '×' + bp.h + ' #' + (this.seq - 1),
      upgrade: isUpgrade,       // 原地升级计划（条目带 upgrade 源类型，切换前旧建筑继续运行）
      priority: VALID_PRIORITIES[opts.priority] ? opts.priority : 'normal',
      paused: false,
      deps: [],                 // 前置计划 id：全部完工/取消前本计划挂起
      entries: bp.entries.map(e => ({
        type: e.type, x: ox + e.dx, y: oy + e.dy, dir: e.dir || 0,
        recipe: e.recipe || null, filter: e.filter || null,
        demandMode: !!e.demandMode, priority: e.priority || 'normal',
        stationName: e.stationName || null,
        upgrade: isUpgrade && e.fromType ? { from: e.fromType } : null, // 原地升级条目
        state: 'wait',           // wait | done | skip
        stock: {},               // 该条目已预留（移出物流）的建材
      })),
      cursor: 0,
      timer: 0,
      waiting: false,            // 缺料等待（UI 状态）
      blocked: false,            // 等待前置依赖（UI 状态）
    };
    this.plans.push(plan);
    FG.Events.emit('construction:change');
    return plan;
  }

  /** 某格是否有待建条目（校验/悬浮提示用），暂停计划的格子同样占位 */
  entryAt(x, y) {
    for (const p of this.plans) {
      for (const e of p.entries) {
        if (e.state === 'wait' && e.x === x && e.y === y) return { plan: p, entry: e };
      }
    }
    return null;
  }

  // ================= 计划操作（面板） =================
  /** 设置计划优先级（高/中/低），立即参与下一轮统一分配 */
  setPriority(planId, priority) {
    const p = this.byId(planId);
    if (!p || !VALID_PRIORITIES[priority]) return false;
    p.priority = priority;
    FG.Events.emit('construction:change');
    return true;
  }

  setPaused(planId, paused) {
    const p = this.byId(planId);
    if (!p || p.paused === paused) return false;
    p.paused = paused;
    if (paused) this.releaseReserved(p); // 暂停即释放全部预留，建材回归物流
    FG.Events.emit('construction:change');
    return true;
  }

  togglePaused(planId) {
    const p = this.byId(planId);
    return p ? this.setPaused(planId, !p.paused) : false;
  }

  /**
   * 设置前置依赖（覆盖式）：自动剔除不存在/已完工/自身的 id，并做环检测；
   * 加入依赖会让计划立即挂起并释放预留，解除依赖后自动恢复。
   */
  setDeps(planId, depIds) {
    const p = this.byId(planId);
    if (!p) return false;
    const ids = [];
    for (const id of depIds || []) {
      const d = this.byId(id);
      if (d && d !== p && !ids.includes(id)) ids.push(id);
    }
    p.deps = ids;
    if (this.createsCycle(p)) {
      p.deps = [];
      this.game.logMsg('⚠ 无法为「' + p.name + '」设置前置：存在循环依赖', 'error');
      return false;
    }
    if (ids.length && !this.depsSatisfied(p)) this.releaseReserved(p);
    FG.Events.emit('construction:change');
    return true;
  }

  addDep(planId, depId) {
    const p = this.byId(planId);
    if (!p) return false;
    if (p.deps.includes(depId)) return true;
    const next = p.deps.concat([depId]);
    return this.setDeps(planId, next);
  }

  removeDep(planId, depId) {
    const p = this.byId(planId);
    if (!p) return false;
    p.deps = p.deps.filter(id => id !== depId);
    FG.Events.emit('construction:change');
    return true;
  }

  byId(id) { return this.plans.find(p => p.id === id) || null; }

  /** 前置是否全部满足（前置计划已完工出列或被取消 → 视为满足） */
  depsSatisfied(p) {
    for (const id of p.deps) if (this.byId(id)) return false;
    return true;
  }

  /** 从 p 沿 deps 边是否能走回 p（环检测） */
  createsCycle(p) {
    const stack = p.deps.slice();
    const seen = new Set();
    while (stack.length) {
      const id = stack.pop();
      if (id === p.id) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      const d = this.byId(id);
      if (d) stack.push(...d.deps);
    }
    return false;
  }

  // ================= 主循环：统一建材池 × 优先级分层 × 同级轮转 =================
  tick() {
    // 先清理已无待建条目的计划（返还残余预留），避免 depsSatisfied 误判
    for (let i = this.plans.length - 1; i >= 0; i--) {
      const p = this.plans[i];
      if (!p.entries.some(e => e.state === 'wait')) {
        this.finish(p);
        this.plans.splice(i, 1);
      }
    }
    if (!this.plans.length) return;

    // 状态复位 + 暂停/挂起计划释放预留（不参与本轮分配）
    for (const p of this.plans) {
      p.waiting = false;
      p.blocked = false;
      if (p.paused || !this.depsSatisfied(p)) {
        p.blocked = !p.paused; // 暂停优先显示「已暂停」
        this.releaseReserved(p);
      }
    }

    // 全局自由建材池：箱子 → 地面物料堆（每 tick 盘点一次，所有计划共享预算）
    const pool = new MaterialPool(this.game);
    this.tierStart = { high: 0, normal: 0, low: 0 };

    for (const tier of TIERS) {
      const list = this.plans.filter(p => p.priority === tier && !p.paused && this.depsSatisfied(p));
      if (!list.length) continue;
      // 同级从轮转游标起步，每轮回到同一计划时其 cursor 已推进
      const start = this.tierStart[tier] % list.length;
      let progressed = false;
      for (let n = 0; n < list.length; n++) {
        const p = list[(start + n) % list.length];
        if (this.processPlan(p, pool)) progressed = true;
      }
      // 本轮有计划推进（预留/落成），下轮从它后面开始：同级公平
      if (progressed) this.tierStart[tier] = (start + 1) % list.length;
    }
  }

  /**
   * 推进单个计划一轮：
   *  1. 跳过已建成/被占位的条目，推进 cursor；
   *  2. 前沿条目尽量预留缺口建材（可部分预留），凑齐且间隔到期则建成；
   *  3. 前沿缺料时，向后找一栋「整套成本本轮能一次凑齐」的条目先建（推进可施工部分）。
   * 返回本轮是否有推进（预留到新料或落成建筑）。
   */
  processPlan(p, pool) {
    let progressed = false;

    // 落成节奏：相邻建筑间隔 CONSTRUCT_BUILD_INTERVAL tick（冷却中只推进游标，不占料）
    if (p.timer > 0) p.timer--;

    // 推进 cursor 到下一待建条目；顺带复验已不可放置的条目（提交后被占 → 跳过）。
    // 每轮先把 cursor 收敛到「索引最小的 wait 条目」作为前沿：条目按 y 优先扫描顺序
    // 生成，先前 tick 超前建成的条目可能让更小索引成为新前沿，靠这里回位，避免漏建。
    let firstWait = -1;
    for (let i = 0; i < p.entries.length; i++) {
      if (p.entries[i].state === 'wait') { firstWait = i; break; }
    }
    if (firstWait >= 0 && firstWait < p.cursor) p.cursor = firstWait;
    while (p.cursor < p.entries.length) {
      const e = p.entries[p.cursor];
      if (e.state !== 'wait') { p.cursor++; continue; }
      if (!this.entryStillValid(e)) {
        e.state = 'skip';
        this.releaseEntryStock(e);
        this.game.logMsg('⚠ 「' + p.name + '」跳过 (' + e.x + ',' + e.y + ') '
          + FG.Buildings.byId(e.type).name
          + (e.upgrade ? '：待升级的原建筑已不存在或被改动' : '：位置被占用或地形不符'), 'error');
        p.cursor++;
        progressed = true;
        continue;
      }
      break;
    }
    if (p.cursor >= p.entries.length) return progressed;
    // 落成冷却中：不提前抢料（避免占着建材不公平），等间隔到期下轮再分配
    if (p.timer > 0) return progressed;

    // 前沿条目：尽量预留（部分预留），凑齐即可建成
    const head = p.entries[p.cursor];
    if (this.pullEntry(head, pool, false)) progressed = true;
    let target = this.entryReady(head) ? head : null;

    // 前沿缺料时，向后找一栋「现在就能凑齐整套成本」的条目先建（推进可施工部分）
    if (!target) {
      p.waiting = true;
      for (let i = p.cursor + 1; i < p.entries.length; i++) {
        const e = p.entries[i];
        if (e.state !== 'wait' || !this.entryStillValid(e)) continue;
        // 已成套（可能上一 tick 冷却期已预留）或本轮能成套取出，即作为先建目标；
        // all=true 两阶段原子：成套或一件不取，无回滚
        if (this.entryReady(e) || this.pullEntry(e, pool, true)) { target = e; break; }
      }
    }

    if (target) {
      this.consumeAndBuild(p, target);
      progressed = true;
      if (target === head) p.cursor++;
    }
    return progressed;
  }

  /**
   * 条目此刻是否仍可施工：
   *  - 普通建造：空格且地形允许（canPlace）；
   *  - 原地升级：同格仍是提交时记录的源类型建筑（旧建筑在备料期继续生产）。
   */
  entryStillValid(e) {
    if (!e.upgrade) return this.game.canPlace(e.type, e.x, e.y);
    const cur = this.game.map.buildingAt(e.x, e.y);
    return !!cur && cur.type === e.upgrade.from;
  }

  /** 条目预留是否已凑齐整套成本 */
  entryReady(e) {
    const cost = FG.Buildings.costOf(e.type);
    for (const item of Object.keys(cost)) {
      if ((e.stock[item] || 0) < cost[item]) return false;
    }
    return true;
  }

  /**
   * 从统一建材池预留该条目缺口建材（两阶段，先验后取，无回滚路径）：
   *  all=true 必须整套都能凑齐（任一料不足则一件不取，供「可施工部分」探测）；
   *  all=false 尽量取（前沿条目可部分预留）。返回是否实际取到料。
   */
  pullEntry(e, pool, all) {
    const cost = FG.Buildings.costOf(e.type);
    const items = Object.keys(cost);
    const want = {};
    for (const item of items) {
      want[item] = cost[item] - (e.stock[item] || 0);
      if (all && want[item] > 0 && pool.available(item) < want[item]) return false;
    }
    let gotAny = false;
    for (const item of items) {
      if (want[item] <= 0) continue;
      const got = pool.take(item, want[item]); // all 模式必足量；非 all 模式取尽其有
      if (got > 0) {
        e.stock[item] = (e.stock[item] || 0) + got;
        gotAny = true;
      }
    }
    return gotAny;
  }

  /** 消耗条目预留建材；普通条目落成新建筑，升级条目在同格原建筑上换型 */
  consumeAndBuild(p, e) {
    // 终检：升级源建筑在备齐后、落成前一 tick 被拆除/改建 → 安全跳过并返还预留
    if (e.upgrade && !this.entryStillValid(e)) {
      e.state = 'skip';
      this.releaseEntryStock(e);
      return;
    }
    const cost = FG.Buildings.costOf(e.type);
    for (const item of Object.keys(cost)) {
      e.stock[item] -= cost[item];
      if (e.stock[item] <= 0) delete e.stock[item];
    }
    if (e.upgrade) this.upgradeEntry(e);
    else this.buildEntry(e);
    e.state = 'done';
    p.timer = FG.Config.CONSTRUCT_BUILD_INTERVAL;
    FG.Events.emit('construction:change');
  }

  /**
   * 原地升级切换（分步切换的单步落点）：旧建筑备料完成前始终运行，本 tick 才换型。
   * 在同一运行时对象上替换 def/type，保留全部物料与运行态：
   * 配方、输入/输出槽库存、流体缓存罐、带面在途物品（含在途预留标签 → 消费者 key
   * 即本格坐标，换型后依然有效）、合流游标、机械臂手持物/动作相位/计时、
   * 箱子货位、矿脉绑定、累计产量、车站 id/名称、筛选/按需/供料优先级。
   */
  upgradeEntry(e) {
    const g = this.game;
    const old = g.map.buildingAt(e.x, e.y);
    if (!old || old.type !== e.upgrade.from) return;   // 理论不可达：consumeAndBuild 已终检
    const newDef = FG.Buildings.byId(e.type);
    const oldType = old.type;
    g.sim.unregister(old);

    // 箱子货位：高档若有 storage（当前升级链不含，保险处理）补齐槽位
    if (newDef.storage) {
      while (old.chest.length < FG.Config.CHEST_SLOTS) {
        old.chest.push({ type: null, count: 0, cap: FG.Config.CHEST_SLOT_CAP });
      }
    }
    // 同 recipeGroup 升级（石炉→钢炉、组装机→二级）：旧配方保留，补齐槽位；
    // 旧配方在新建筑不可用（极端情况）则清空，残留槽位物料仍保留可被运走
    if (newDef.recipeBuilding) {
      const stillValid = old.recipe
        && g.research.isRecipeUnlocked(old.recipe)
        && FG.Recipes.forBuilding(e.type).some(r => r.id === old.recipe);
      if (stillValid) FG.Map.syncRecipeSlots(old);
      else old.recipe = null;
    }
    // 实验室科学包槽位补齐
    if (newDef.science) {
      for (const s of ['science1', 'science2', 'science3']) {
        if (!old.slots.inputs[s]) old.slots.inputs[s] = { count: 0, cap: 50 };
      }
    }
    // 换型：def/type 替换，其余字段（dir/slots/items/held/timer/fluidTanks/level/
    // chest/oreType/priority/rr/progress/totalCrafted/stationId…）全部保留
    old.def = newDef;
    old.type = e.type;
    old.status = old.status || 'idle';

    g.sim.register(old);
    g.map.register(old);   // 同 key 覆盖（值为同一对象）
    if (oldType === 'rail' || newDef.railStation) g.railway.markDirty();
    // 该格若有残余地面堆（旧建筑槽位装不下的历史遗留），换型后顺手回收
    g.absorbPile(old);
    if (g.selection === old) FG.Events.emit('selection:change', old);
    FG.Events.emit('building:upgraded', { building: old, from: oldType });
    FG.Events.emit('building:placed', old);
  }

  /** 落成一栋建筑：注册进地图与仿真，还原产线配置（配方/筛选/按需/优先级） */
  buildEntry(e) {
    const g = this.game;
    const b = FG.Map.create(e.type, e.x, e.y, e.dir);
    if (b.type === 'miner') b.oreType = g.map.oreAt(e.x, e.y);
    if (b.def.railStation) {
      b.stationId = 'S' + (g.railway.stationSeq++);
      b.stationName = e.stationName || ('站点 ' + b.stationId.slice(1));
    }
    g.map.register(b);
    g.sim.register(b);   // 接入生产调度：纳入每 tick 调度/传送带/机械臂/生产更新
    if (b.type === 'rail' || b.def.railStation) g.railway.markDirty();
    if (e.recipe && b.def.recipeBuilding && g.research.isRecipeUnlocked(e.recipe)) {
      b.recipe = e.recipe;
      FG.Map.syncRecipeSlots(b);
    }
    if (b.def.inserterTier !== undefined) {
      b.filter = e.filter;
      b.demandMode = e.demandMode;
    }
    if (b.def.recipeBuilding || b.type === 'lab') b.priority = e.priority;
    g.absorbPile(b);     // 回收该格地面物料
    FG.Events.emit('building:placed', b);
    return b;
  }

  // ================= 预留释放（暂停 / 挂起依赖 / 取消） =================
  /** 返还单个条目的预留建材到该条目坐标（优先箱子，余下落地） */
  releaseEntryStock(e) {
    if (!e || !e.stock || !Object.keys(e.stock).length) return;
    this.refundToLogistics(e.stock, e.x, e.y);
  }

  /** 释放整个计划的全部条目预留（暂停 / 等待前置 / 取消） */
  releaseReserved(p) {
    for (const e of p.entries) {
      if (e.state === 'wait') this.releaseEntryStock(e);
    }
  }

  /** 把库存建材返还物流：优先放回箱子，放不下的落到 (x,y) 地面堆 */
  refundToLogistics(stock, x, y) {
    for (const item of Object.keys(stock)) {
      let left = stock[item];
      if (left <= 0) { delete stock[item]; continue; }
      for (const b of this.game.map.buildings.values()) {
        if (left <= 0) break;
        if (b.type === 'chest') left = this.game.tryChestAdd(b, item, left);
      }
      if (left > 0) this.game.map.pileAdd(x, y, item, left);
      delete stock[item];
    }
  }

  /** 计划完工：剩余预留建材返还，移出列表 */
  finish(p) {
    this.releaseReserved(p);
    const built = p.entries.filter(e => e.state === 'done').length;
    const skipped = p.entries.filter(e => e.state === 'skip').length;
    const upgraded = p.upgrade
      ? p.entries.filter(e => e.state === 'done' && e.upgrade).length
      : 0;
    this.game.logMsg(
      (p.upgrade ? '⬆ 原地升级完成「' : '🏗 施工完成「') + p.name + '」：' + built
      + (p.upgrade ? ' 栋建筑已换型为高级建筑' : ' 栋建筑建成并接入生产调度')
      + (skipped ? '，' + skipped + ' 栋被跳过' : ''), 'unlock');
    FG.Events.emit('construction:change');
  }

  /** 取消计划：已预留建材返还物流，已建成/已换型建筑保留；其下游依赖自动解除 */
  cancel(planId) {
    const i = this.plans.findIndex(p => p.id === planId);
    if (i < 0) return false;
    const p = this.plans[i];
    this.releaseReserved(p);
    const done = p.entries.filter(e => e.state === 'done').length;
    const pending = p.entries.filter(e => e.state === 'wait' && e.upgrade).length;
    this.plans.splice(i, 1);
    this.game.logMsg('已取消' + (p.upgrade ? '原地升级' : '施工') + '计划「' + p.name + '」：'
      + done + ' 栋已' + (p.upgrade ? '换型' : '建成') + '保留，'
      + (pending ? pending + ' 栋未切换的原建筑继续运行，' : '')
      + '预留建材已返还物流', 'info');
    FG.Events.emit('construction:change');
    return true;
  }

  // ================= 序列化（施工进度随存档恢复） =================
  serialize() {
    return {
      seq: this.seq,
      plans: this.plans.map(p => ({
        id: p.id, name: p.name, priority: p.priority, paused: !!p.paused,
        upgrade: !!p.upgrade,
        deps: (p.deps || []).slice(),
        cursor: p.cursor, timer: p.timer, waiting: p.waiting,
        entries: p.entries.map(e => ({
          type: e.type, x: e.x, y: e.y, dir: e.dir, recipe: e.recipe,
          filter: e.filter, demandMode: e.demandMode, priority: e.priority, state: e.state,
          stationName: e.stationName || null,
          upgrade: e.upgrade ? { from: e.upgrade.from } : null,
          stock: Object.assign({}, e.stock),
        })),
      })),
    };
  }

  deserialize(data) {
    this.plans = [];
    this.seq = (data && data.seq) || 1;
    for (const sp of ((data && data.plans) || [])) {
      const entries = (sp.entries || []).map(e => ({
        type: e.type, x: e.x, y: e.y, dir: e.dir || 0,
        recipe: e.recipe || null, filter: e.filter || null,
        demandMode: !!e.demandMode, priority: e.priority || 'normal',
        stationName: e.stationName || null,
        upgrade: e.upgrade && e.upgrade.from ? { from: e.upgrade.from } : null,
        fromType: e.fromType || null,   // 旧档字段：下方迁移到 upgrade.from
        state: e.state || 'wait',
        stock: e.stock || {},
      }));
      // 旧档兼容：条目可能用 fromType 记升级源（无 upgrade 包装）
      for (const e of entries) {
        if (!e.upgrade && e.fromType) e.upgrade = { from: e.fromType };
      }
      // 旧档兼容：升级条目若同格建筑已不是源类型（手动改过/源档缺失），读档即标记跳过，
      // 返还预留，避免悬空换型
      const plan = {
        id: sp.id || ('P' + (this.seq - 1)),
        name: sp.name || '施工计划',
        priority: VALID_PRIORITIES[sp.priority] ? sp.priority : 'normal',
        paused: !!sp.paused,
        upgrade: !!sp.upgrade,
        deps: Array.isArray(sp.deps) ? sp.deps.slice() : [],
        cursor: sp.cursor || 0,
        timer: sp.timer || 0,
        waiting: !!sp.waiting,
        blocked: false,
        entries,
      };
      // 旧存档兼容：旧版预留记在计划级 p.stock，迁移到前沿待建条目，续建语义不变
      if (sp.stock && typeof sp.stock === 'object') {
        const head = entries.find(e => e.state === 'wait');
        if (head) head.stock = Object.assign({}, sp.stock);
      }
      // 依赖指向的计划不在档内（已完工/旧档缺字段）→ 视为已满足，直接剔除
      plan.deps = plan.deps.filter(id => id !== plan.id);
      this.plans.push(plan);
    }
    // 二次清理悬空依赖
    const ids = new Set(this.plans.map(p => p.id));
    for (const p of this.plans) p.deps = p.deps.filter(id => ids.has(id));
  }
};

const TIERS = ['high', 'normal', 'low'];
const VALID_PRIORITIES = { high: 1, normal: 1, low: 1 };

/**
 * 全局建材预算池：tick 初盘点全图自由建材（箱子→地面堆），
 * take 时同步物理取出（预留即移出物流，机械臂/调度不可再取）。
 */
class MaterialPool {
  constructor(game) {
    this.game = game;
    this.free = new Map();   // item -> 可分配总量
    this.chests = [];
    for (const b of game.map.buildings.values()) {
      if (!b.def.storage) continue;
      this.chests.push(b);
      for (const s of b.chest) {
        if (s.type && s.count > 0) this.free.set(s.type, (this.free.get(s.type) || 0) + s.count);
      }
    }
    this.piles = [];
    for (const [k, pile] of game.map.piles) {
      for (const s of pile) {
        if (s.type && s.count > 0) this.free.set(s.type, (this.free.get(s.type) || 0) + s.count);
      }
      this.piles.push([k, pile]);
    }
  }

  available(item) { return this.free.get(item) || 0; }

  /** 取走至多 n 件（箱子优先，不足再取地面堆），返回实际取得数 */
  take(item, n) {
    const avail = this.available(item);
    let left = Math.min(n, avail);
    if (left <= 0) return 0;
    const got = left;
    for (const b of this.chests) {
      if (left <= 0) break;
      for (const s of b.chest) {
        if (left <= 0) break;
        if (s.type === item && s.count > 0) {
          const take = Math.min(left, s.count);
          s.count -= take;
          left -= take;
        }
      }
    }
    if (left > 0) {
      for (const [k, pile] of this.piles) {
        if (left <= 0) break;
        const s = pile.find(x => x.type === item && x.count > 0);
        if (!s) continue;
        const take = Math.min(left, s.count);
        s.count -= take;
        left -= take;
        if (s.count <= 0) pile.splice(pile.indexOf(s), 1);
      }
      for (const [k, pile] of this.piles) {
        if (!pile.length) this.game.map.piles.delete(k);
      }
    }
    this.free.set(item, avail - got);
    return got;
  }
}

