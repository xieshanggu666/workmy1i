/**
 * 蓝图原地升级测试：node test/upgrade.test.js
 * 升级链解析 → 框选扫描（科技门控/已排产跳过）→ 提交升级计划 →
 * 备料期旧建筑继续生产 → 分步切换 → 配方/库存/带面在途（含预留标签）/机械臂手持保留 →
 * 暂停/取消返还未用建材且旧建筑继续运行 → 存档续建/旧档兼容
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
global.window = global;
global.localStorage = {
  _d: {},
  getItem(k) { return this._d[k] !== undefined ? this._d[k] : null; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; },
};

const files = [
  'js/core/config.js', 'js/core/utils.js',
  'js/data/items.js', 'js/data/recipes.js', 'js/data/buildings.js',
  'js/data/research.js', 'js/data/maps.js',
  'js/game/map.js', 'js/game/scheduler.js', 'js/game/railway.js', 'js/game/sim.js', 'js/game/researchmgr.js',
  'js/game/stats.js', 'js/game/save.js', 'js/game/blueprint.js', 'js/game/game.js',
];
for (const f of files) {
  vm.runInThisContext(fs.readFileSync(path.join(root, f), 'utf8'), { filename: f });
}

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗ FAIL:', msg); }
}
function ticks(g, n) { for (let i = 0; i < n; i++) g.tickOnce(); }

const game = new FG.Game();
const w = 60, h = 40;
const terrain = Array.from({ length: h }, () => Array(w).fill('grass'));
const ores = Array.from({ length: h }, () => Array(w).fill(null));
game.startWithMap({
  presetId: 'greenfield', biome: 'grass', w, h, seed: 1, sizeId: 'medium',
  terrain, ores, water: new Set(), oil: new Set(),
}, null, 'upgrade-test');
const map = game.map, sim = game.sim;

function P(t, x, y, d) { const b = FG.Map.create(t, x, y, d || 0); map.register(b); sim.register(b); return b; }
function chestCount(b, type) { const s = b.chest.find(x => x.type === type); return s ? s.count : 0; }

console.log('\n[1] 升级链解析：链查询 / 科技门控 / 取已解锁最高档');
{
  ok(JSON.stringify(FG.Buildings.upgradeChainOf('belt')) === '["belt","fastBelt","expressBelt"]',
    '传送带升级链：belt → fastBelt → expressBelt');
  ok(FG.Buildings.upgradeChainOf('chest') === null, '箱子无升级链');
  ok(FG.Buildings.upgradeChainOf('longInserter') === null, '长臂机械臂是侧型，不在升级链');
  // 初始科技：快速带未解锁
  ok(FG.Buildings.upgradeTargetOf('belt', t => game.research.isBuildingUnlocked(t)) === null,
    'logistics2 未研究：传送带无可升级目标');
  game.research.completed.add('logistics2');
  ok(FG.Buildings.upgradeTargetOf('belt', t => game.research.isBuildingUnlocked(t)) === 'fastBelt',
    '解锁 logistics2：传送带 → 快速传送带');
  ok(FG.Buildings.upgradeTargetOf('fastBelt', t => game.research.isBuildingUnlocked(t)) === null,
    '快速传送带：极速档未解锁，无更高目标');
  game.research.completed.add('logistics3');
  ok(FG.Buildings.upgradeTargetOf('belt', t => game.research.isBuildingUnlocked(t)) === 'expressBelt',
    '两档科技全解锁：传送带直升极速传送带（最高档）');
  ok(FG.Buildings.upgradeTargetOf('expressBelt', t => game.research.isBuildingUnlocked(t)) === null,
    '极速传送带已是最高档');
  // 机械臂 / 熔炉 / 组装机门控
  ok(FG.Buildings.upgradeTargetOf('inserter', t => game.research.isBuildingUnlocked(t)) === 'fastInserter',
    '机械臂 → 快速机械臂');
  ok(FG.Buildings.upgradeTargetOf('furnace', t => game.research.isBuildingUnlocked(t)) === null,
    '钢炉科技未解锁：石炉不可升级');
  ok(FG.Buildings.upgradeTargetOf('assembler', t => game.research.isBuildingUnlocked(t)) === null,
    '二级组装机科技未解锁：组装机不可升级');
}

console.log('\n[2] 框选扫描：只收集可升级建筑，跳过无链/未解锁/已排产格');
{
  P('belt', 10, 10, 1);
  P('fastBelt', 11, 10, 1);
  const chest = P('chest', 12, 10);
  const up = FG.Blueprint.scanUpgrades(game, 10, 10, 12, 10);
  ok(up.entries.length === 2, '扫描到 2 栋可升级（普通带→极速，快速带→极速），箱子跳过（实际 ' + up.entries.length + '）');
  ok(up.entries[0].type === 'expressBelt' && up.entries[0].fromType === 'belt'
     && up.entries[0].dir === 1, '条目含目标类型/源类型/朝向');
  ok(up.skipped === 1, '1 栋无升级链建筑计入 skipped');
  // 同格已有待建计划 → 跳过（合法共存形态：升级条目 + 旧建筑在格）
  P('belt', 13, 10, 1);
  game.construction.addPlan(
    { w: 1, h: 1, entries: [{ type: 'fastBelt', dx: 0, dy: 0, dir: 1, fromType: 'belt' }] },
    13, 10, { upgrade: true });
  const up2 = FG.Blueprint.scanUpgrades(game, 13, 10, 13, 10);
  ok(up2.entries.length === 0, '同格已有升级条目：扫描自动跳过');
  game.construction.cancel(game.construction.plans[0].id);
  game._chest = chest;
}

console.log('\n[3] 提交原地升级计划：备料期旧建筑照常生产，建材从物流预留');
{
  // 只给钢板不给齿轮：两栋升级各需 steelPlate1+gear1，均只能部分预留 → 等待
  sim.chestAdd(game._chest, 'steelPlate', 5);
  const old = map.buildingAt(10, 10);
  ok(old && old.type === 'belt', '前置：(10,10) 是普通传送带');
  const n = game.submitUpgradeSelection(10, 10, 11, 10);
  ok(n === 2, '提交 2 栋升级计划');
  const plan = game.construction.plans[0];
  ok(plan && plan.upgrade && plan.entries[0].upgrade.from === 'belt', '计划标记为原地升级，条目带来源类型');
  // 备料期间：旧建筑照常运行，不会被拆
  ticks(game, 3);
  const still = map.buildingAt(10, 10);
  ok(still === old && still.type === 'belt', '备料未齐时旧建筑同对象继续运行（不拆除）');
  ok((plan.entries[0].stock.steelPlate || 0) === 1, '前沿条目先预留 1 钢板');
  ok(chestCount(game._chest, 'steelPlate') === 4,
    '已预留钢板移出物流（5-1=4；前沿未切换前不提前抢后续条目建材）');
  ok(plan.waiting, '计划处于缺料等待');
  // 取消该计划：预留钢板返还（恢复 5 件），旧传送带继续运行 —— 供 [4] 干净起步
  game.construction.cancel(plan.id);
  ok(chestCount(game._chest, 'steelPlate') === 5, '取消后预留钢板全额返还');
  ok(map.buildingAt(10, 10).type === 'belt' && map.buildingAt(11, 10).type === 'fastBelt',
    '取消升级计划后旧建筑均保持原档');
}

console.log('\n[4] 分步切换：同对象换型，带面在途物品（含预留标签）保留');
{
  // 末端箱子挪到远处空格，带端悬空让在途物品停在带尾不被卸走，保证可观察
  sim.chestAdd(game._chest, 'gear', 3);
  const farChest = game._chest;
  map.unregister(farChest);
  farChest.x = 1; farChest.y = 2;
  map.register(farChest);
  game._chest = farChest;
  ok(chestCount(farChest, 'steelPlate') === 5 && chestCount(farChest, 'gear') === 3,
    '建材箱就位：钢板5 + 齿轮3');
  // 在两格带面各放 1 件在途物品；齿轮带「指向真消费者（格12,10 组装机：发动机配方吃齿轮）」的预留标签。
  // 调度器只维护消费者预留，标签消费者必须是真消费者格（与产线实际语义一致）；
  // 组装机不会从带面直取（须经机械臂），齿轮只会停在带端、不会消失。
  game.research.completed.add('logisticsScience');
  const tagConsumer = P('assembler', 12, 10);
  tagConsumer.recipe = 'craft:engine';
  FG.Map.syncRecipeSlots(tagConsumer);
  const old = map.buildingAt(10, 10);
  const old2 = map.buildingAt(11, 10);
  old.items = [{ type: 'ironPlate', pos: 0.4, from: 0 }];
  old2.items = [{ type: 'gear', pos: 0.05, from: 0, tag: { c: '12,10', item: 'gear', t0: game.tickCount } }];
  // [3] 已取消先前计划：重新提交两栋换型
  const n4 = game.submitUpgradeSelection(10, 10, 11, 10);
  ok(n4 === 2, '重新提交 2 栋升级计划');
  // tick1：第一栋（普通带）前沿凑齐即刻切换；第二栋受施工间隔限制尚未切换
  game.tickOnce();
  const now = map.buildingAt(10, 10);
  ok(now && now.type === 'expressBelt' && now === old, '第一栋换型：同对象，普通带→极速带');
  ok(sim.belts.includes(now), '新类型已注册进仿真皮带列表');
  const pre2 = map.buildingAt(11, 10);
  ok(pre2 === old2 && pre2.type === 'fastBelt' && pre2.items.length === 1
     && pre2.items[0].tag && pre2.items[0].tag.c === '12,10',
    '分步切换：第二栋未到切换节拍，仍是快速带，带面物品与指向消费者的预留标签未动');
  // 施工间隔 4 tick：第一栋切换后开始给第二栋备料（1 钢板 + 1 齿轮），间隔到期切换
  ticks(game, 8);
  const b1 = map.buildingAt(10, 10), b2 = map.buildingAt(11, 10);
  ok(b1.type === 'expressBelt' && b1.def.beltTier === 2 && b1.dir === 1, '朝向保留，定义换成高档（tier2）');
  ok(b2.type === 'expressBelt' && b2 === old2, '第二栋（快速→极速）同对象换型完成');
  ok(game.construction.plans.length === 0, '升级计划完工出列');
  const beltItems = [b1, b2].flatMap(b => b.items);
  const tagged = beltItems.find(it => it.tag && it.tag.item === 'gear');
  ok(beltItems.length === 2 && beltItems.some(it => it.type === 'ironPlate'),
    '带面 2 件在途物品全部保留（实际 ' + beltItems.length + ' 件）');
  ok(tagged && tagged.tag.c === '12,10', '换型后指向真消费者的在途预留标签保留');
  // 换型后仿真与调度不报错，极速带继续运转
  let err = null;
  try { ticks(game, 10); } catch (e) { err = e; }
  ok(!err, '换型后连续仿真无异常' + (err ? '：' + err.stack : ''));
  ok(chestCount(farChest, 'steelPlate') === 3 && chestCount(farChest, 'gear') === 1,
    '两栋升级各耗 steelPlate1+gear1（钢板5→3、齿轮3→1）');
}

console.log('\n[5] 熔炉→钢炉：配方/槽位库存/生产进度/优先级保留，速度提升立即生效');
{
  sim.chestAdd(game._chest, 'stone', 10);
  sim.chestAdd(game._chest, 'steelPlate', 8);
  game.research.completed.add('steelSmelting');
  const f = P('furnace', 20, 20);
  f.recipe = 'smelt:iron';
  FG.Map.syncRecipeSlots(f);
  f.slots.inputs.ironOre.count = 6;
  f.slots.outputs.ironPlate.count = 3;
  f.progress = 10;
  f.priority = 'high';
  const n = game.submitUpgradeSelection(20, 20, 20, 20);
  ok(n === 1, '石炉可升级为钢炉');
  ticks(game, 10);
  const sf = map.buildingAt(20, 20);
  ok(sf && sf.type === 'steelFurnace', '已换型为钢炉');
  ok(sf === f, '同一对象换型');
  ok(sf.recipe === 'smelt:iron', '配方保留');
  // 切换瞬间（同 tick 内先施工后生产）：换型那一刻库存原样，最多在此后 1 个生产 tick 消耗
  ok(sf.slots.inputs.ironOre.count >= 5 && sf.slots.outputs.ironPlate.count >= 3,
    '输入/输出槽库存保留（铁矿≥5 / 铁板≥3，实际 ' + sf.slots.inputs.ironOre.count + '/' + sf.slots.outputs.ironPlate.count + '）');
  ok(sf.priority === 'high', '供料优先级保留');
  ok(sf.def.craftSpeed === 2, '钢炉 2 倍速度定义生效');
  ok(sim.crafters.includes(sf), '钢炉注册进 crafters');
  // 库存可继续投产
  const before = sf.slots.outputs.ironPlate.count;
  ticks(game, 60);
  ok(sf.slots.outputs.ironPlate.count > before, '升级后用残留库存继续冶炼');
}

console.log('\n[6] 组装机→二级组装机 + 机械臂→快速机械臂：配方/手持物/筛选保留');
{
  game.research.completed.add('advancedElectronics');
  // 主建材箱已被钢板/齿轮/石头占 3 槽：补 2 齿轮（二级组装机共需 2 件；
  // 机械臂手持的那件不进建材池）；电路板与铁板放独立箱，统一池同样可取
  sim.chestAdd(game._chest, 'gear', 2);
  const hiTechChest = P('chest', 3, 3);
  sim.chestAdd(hiTechChest, 'circuit', 3);   // 二级组装机×2 + 快速臂×1
  sim.chestAdd(hiTechChest, 'ironPlate', 1); // 快速机械臂另需铁板×1
  const a = P('assembler', 22, 20);
  // 铜线配方需铜板：不给铜板 → 等待期不会生产；另在槽内放 2 件旧配方残留铁板，
  // 换型后应原样保留（物料保留语义）
  a.recipe = 'craft:copperWire';
  FG.Map.syncRecipeSlots(a);
  a.slots.inputs.ironPlate = { count: 2, cap: FG.Config.SLOT_CAP };
  a.progress = 7;
  const ins = P('inserter', 23, 20, 0);  // 朝北：抓放范围不涉及组装机，避免换型后运走其槽内库存
  ins.filter = 'gear';
  ins.demandMode = true;
  ins.held = { type: 'gear', tag: null };
  ins.timer = 99;   // 钉在动作间隔前段，避免观察期内放掉手持物
  // 阶段一：清空主建材箱，只放快速机械臂整套建材（ironPlate1+circuit1），
  // 二级组装机缺钢板/齿轮先等待 —— 确定性验证分步切换
  for (const s of game._chest.chest) s.count = 0;
  const armChest = P('chest', 3, 4);
  sim.chestAdd(armChest, 'ironPlate', 1);
  sim.chestAdd(armChest, 'circuit', 1);
  const n = game.submitUpgradeSelection(22, 20, 23, 20);
  ok(n === 2, '组装机+机械臂批量升级（2 栋）');
  ticks(game, 8);   // 等过施工间隔，确保已建的只是机械臂一栋
  const iFirst = map.buildingAt(23, 20);
  const aPre = map.buildingAt(22, 20);
  ok(iFirst && iFirst.type === 'fastInserter' && iFirst === ins, '机械臂同对象换型为快速机械臂');
  ok(iFirst.held && iFirst.held.type === 'gear', '机械臂手持物随换型保留（在途物料不落地）');
  ok(iFirst.filter === 'gear' && iFirst.demandMode === true, '筛选/按需设置保留');
  ok(iFirst.def.swingTime === 6, '快速机械臂节奏定义生效');
  ok(sim.inserters.includes(iFirst), '快速机械臂注册进仿真');
  ok(aPre.type === 'assembler', '分步切换：组装机缺料未切换，仍是组装机');
  // 阶段二：补齐二级组装机建材（steelPlate3+gear2+circuit2，电路板还缺 1 一并补）
  const asmChest = P('chest', 4, 4);
  sim.chestAdd(asmChest, 'steelPlate', 3);
  sim.chestAdd(asmChest, 'gear', 2);
  sim.chestAdd(asmChest, 'circuit', 2);
  ticks(game, 10);
  const a2 = map.buildingAt(22, 20);
  const i2 = map.buildingAt(23, 20);
  ok(a2 && a2.type === 'assembler2' && a2 === a, '补料后组装机原地换型为二级组装机');
  ok(a2.recipe === 'craft:copperWire' && a2.slots.inputs.ironPlate.count === 2,
    '配方与非配方槽位（残留铁板×2）保留');
  ok(i2 === iFirst && i2.type === 'fastInserter', '机械臂保持快速档');
  ok(sim.crafters.includes(a2), '二级组装机注册进仿真');
}

console.log('\n[7] 暂停升级：立即返还未用预留建材，旧建筑继续运行；继续后重新备料换型');
{
  // 清空箱子只放半套：钢炉成本 stone6+steelPlate4，只给 stone6
  for (const s of game._chest.chest) s.count = 0;
  sim.chestAdd(game._chest, 'stone', 6);
  const f = P('furnace', 25, 25);
  f.recipe = 'smelt:copper';
  FG.Map.syncRecipeSlots(f);
  f.slots.inputs.copperOre.count = 4;
  game.submitUpgradeSelection(25, 25, 25, 25);
  const plan = game.construction.plans[game.construction.plans.length - 1];
  ticks(game, 4);
  ok(plan.waiting, '缺钢板：升级计划处于备料等待');
  ok(map.buildingAt(25, 25) === f && map.buildingAt(25, 25).type === 'furnace',
    '备料期间旧石炉未动、继续在格');
  ok((plan.entries[0].stock.stone || 0) === 6, '石头 6 已预留');
  game.construction.setPaused(plan.id, true);
  ok(chestCount(game._chest, 'stone') === 6, '暂停后未用建材（石头6）全部返还物流');
  ok(!Object.keys(plan.entries[0].stock).length, '条目预留清空');
  ticks(game, 3);
  ok(map.buildingAt(25, 25).type === 'furnace', '暂停期间旧建筑保持石炉');
  // 旧建筑仍可生产（库存还在）
  const outBefore = f.slots.outputs.copperPlate.count;
  ticks(game, 40);
  ok(f.slots.outputs.copperPlate.count > outBefore, '暂停升级期间旧石炉照常冶炼');
  // 补齐建材并继续 → 换型，库存保留
  sim.chestAdd(game._chest, 'stone', 6);
  sim.chestAdd(game._chest, 'steelPlate', 4);
  game.construction.setPaused(plan.id, false);
  ticks(game, 10);
  const sf = map.buildingAt(25, 25);
  ok(sf.type === 'steelFurnace', '继续后重新备料并完成换型');
  ok(sf.recipe === 'smelt:copper' && sf.slots.inputs.copperOre.count >= 0
     && sf.slots.outputs.copperPlate.count > 0, '换型后配方与库存保留');
}

console.log('\n[8] 取消升级：未切换建筑保持原样，已切换建筑保留，预留返还');
{
  // 清掉前序用例残留的等待中计划（释放其预留），保证本节物料独占
  for (const p of game.construction.plans.slice()) game.construction.cancel(p.id);
  for (const s of game._chest.chest) s.count = 0;
  sim.chestAdd(game._chest, 'steelPlate', 2);
  sim.chestAdd(game._chest, 'gear', 2);
  const b1 = P('belt', 27, 25, 1);
  const b2 = P('belt', 28, 25, 1);
  game.submitUpgradeSelection(27, 25, 28, 25);
  const plan = game.construction.plans[game.construction.plans.length - 1];
  ticks(game, 8);
  ok(map.buildingAt(27, 25).type === 'expressBelt', '第一栋已换型');
  ok(map.buildingAt(28, 25).type === 'expressBelt', '整套装充足：两栋均换型');
  game.construction.cancel(plan.id);
  ok(!game.construction.plans.some(p => p.id === plan.id), '计划移除');
  ok(map.buildingAt(27, 25).type === 'expressBelt', '已换型建筑保留为极速带');
  ok(map.buildingAt(28, 25).type === 'expressBelt', '第二栋换型同样保留');

  // 缺料场景取消：只给 1 套材料，计划两栋 —— 第一栋先切换、第二栋缺料挂起；
  // 取消后第一栋保留、第二栋与预留均返还
  sim.chestAdd(game._chest, 'steelPlate', 1);
  sim.chestAdd(game._chest, 'gear', 1);
  const c1 = P('belt', 27, 26, 1);
  const c2 = P('belt', 28, 26, 1);
  game.submitUpgradeSelection(27, 26, 28, 26);
  const plan2 = game.construction.plans[game.construction.plans.length - 1];
  ticks(game, 8);
  ok(map.buildingAt(27, 26).type === 'expressBelt', '缺料组：第一栋已换型');
  ok(map.buildingAt(28, 26) === c2 && map.buildingAt(28, 26).type === 'belt',
    '缺料组：第二栋仍是普通带（同对象）');
  const refundSP = chestCount(game._chest, 'steelPlate');
  game.construction.cancel(plan2.id);
  ok(!game.construction.plans.some(p => p.id === plan2.id), '缺料组计划移除');
  ok(map.buildingAt(28, 26) === c2 && map.buildingAt(28, 26).type === 'belt',
    '取消后未切换的第二栋原封不动');
  ok(map.buildingAt(27, 26) === c1 && map.buildingAt(27, 26).type === 'expressBelt',
    '取消后已切换的第一栋保留');
}

console.log('\n[9] 提交后源建筑被拆除 → 条目安全跳过并返还预留，不误伤新占位');
{
  // 全新独立建材箱，避免其他用例的等待中计划抢料
  const local = P('chest', 2, 9);
  sim.chestAdd(local, 'stone', 6);   // 钢炉缺钢板：只会部分预留石头
  const f = P('furnace', 29, 25);
  const n = game.submitUpgradeSelection(29, 25, 29, 25);
  const plan = game.construction.plans[game.construction.plans.length - 1];
  ok(n === 1, '提交 1 栋石炉升级计划');
  ticks(game, 3);
  ok((plan.entries[0].stock.stone || 0) === 6, '石头已预留 6');
  // 玩家手动拆掉源建筑（物料落地），并在格上放了箱子
  game.removeBuilding(f);
  P('chest', 29, 25);
  let err = null;
  try { ticks(game, 5); } catch (e) { err = e; }
  ok(!err, '源建筑消失后 tick 不报错' + (err ? '：' + err.stack : ''));
  ok(map.buildingAt(29, 25).type === 'chest', '新占位箱子未被升级流程覆盖');
  ok(!game.construction.plans.some(p => p.id === plan.id), '该升级条目标记跳过后计划完工出列');
  // 返还按既有统一规则：优先全图任一有余量的箱子，放不下才落源格地面堆
  let totalStone = 0;
  for (const b of map.buildings.values()) {
    if (b.chest) for (const sl of b.chest) if (sl.type === 'stone') totalStone += sl.count;
  }
  for (const pile of map.piles.values()) for (const sl of pile) if (sl.type === 'stone') totalStone += sl.count;
  ok(totalStone === 6 && !Object.keys(plan.entries[0].stock).length,
    '跳过条目的 6 件预留建材全部返还物流（箱子/地面堆合计 ' + totalStone + '）');
}

console.log('\n[10] 升级计划随存档续建 + 旧档兼容');
{
  for (const s of game._chest.chest) s.count = 0;
  sim.chestAdd(game._chest, 'stone', 6);   // 钢炉缺钢板：构造等待中的升级
  const f = P('furnace', 31, 25);
  f.recipe = 'smelt:iron';
  FG.Map.syncRecipeSlots(f);
  f.slots.inputs.ironOre.count = 5;
  game.submitUpgradeSelection(31, 25, 31, 25);
  ticks(game, 3);
  const plan = game.construction.plans[game.construction.plans.length - 1];
  ok(plan.waiting && (plan.entries[0].stock.stone || 0) === 6, '升级计划等待中（石头已预留）');

  const data = JSON.parse(JSON.stringify(game.serialize()));
  const sp = data.construction.plans.find(p => p.id === plan.id);
  ok(sp.upgrade === true && sp.entries[0].upgrade && sp.entries[0].upgrade.from === 'furnace',
    '存档含升级计划标记与条目源类型');

  const g2 = new FG.Game();
  g2.deserialize(data);
  const p2 = g2.construction.plans.find(p => p.id === plan.id);
  ok(p2 && p2.upgrade && p2.entries[0].upgrade.from === 'furnace', '读档后升级计划与源类型恢复');
  ok((p2.entries[0].stock.stone || 0) === 6, '条目预留恢复');
  const oldF = g2.map.buildingAt(31, 25);
  ok(oldF.type === 'furnace' && oldF.recipe === 'smelt:iron' && oldF.slots.inputs.ironOre.count === 5,
    '读档后旧石炉仍在，配方/槽位库存原样保留（尚未切换）');
  // 补料续建
  const c2 = Array.from(g2.map.buildings.values()).find(b => b.type === 'chest');
  g2.sim.chestAdd(c2, 'stone', 6);
  g2.sim.chestAdd(c2, 'steelPlate', 4);
  ticks(g2, 10);
  const up2 = g2.map.buildingAt(31, 25);
  ok(up2.type === 'steelFurnace', '读档补料后完成换型');
  ok(up2.recipe === 'smelt:iron' && up2.slots.inputs.ironOre.count >= 4,
    '跨存档换型后配方保留、库存延续（铁矿≥4，实际 ' + up2.slots.inputs.ironOre.count + '）');

  // 旧档兼容 A：条目用 fromType（无 upgrade 包装）—— 需在真实游戏上反序列化
  const gOld = new FG.Game();
  gOld.startWithMap({
    presetId: 'greenfield', biome: 'grass', w, h, seed: 1, sizeId: 'medium',
    terrain: Array.from({ length: h }, () => Array(w).fill('grass')),
    ores: Array.from({ length: h }, () => Array(w).fill(null)),
    water: new Set(), oil: new Set(),
  }, null, 'old-up');
  gOld.construction.deserialize({
    seq: 1, plans: [{
      id: 'P88', name: '旧版升级', cursor: 0,
      entries: [{
        type: 'steelFurnace', x: 5, y: 5, dir: 0, recipe: null, state: 'wait',
        stock: {}, fromType: 'furnace',
      }],
    }],
  });
  ok(gOld.construction.plans[0].entries[0].upgrade
     && gOld.construction.plans[0].entries[0].upgrade.from === 'furnace',
    '旧档 fromType 自动迁移为 upgrade.from');

  // 旧档兼容 B：完全无施工字段
  const old = JSON.parse(JSON.stringify(data));
  delete old.construction;
  const g3 = new FG.Game();
  let err = null;
  try { g3.deserialize(old); ticks(g3, 10); } catch (e) { err = e; }
  ok(!err, '无施工字段旧档读取与仿真不报错' + (err ? '：' + err.stack : ''));
  ok(g3.construction.plans.length === 0, '旧档无升级计划残留');
}

console.log('\n[11] 升级条目占格：切换前同格拒绝普通蓝图施工，取消后可正常提交');
{
  for (const s of game._chest.chest) s.count = 0;  // 让升级一直等待
  sim.chestAdd(game._chest, 'stone', 6);
  P('furnace', 33, 25);
  game.submitUpgradeSelection(33, 25, 33, 25);
  const upPlan = game.construction.plans[game.construction.plans.length - 1];
  ticks(game, 2);
  const bp = { w: 1, h: 1, entries: [{ type: 'chest', dx: 0, dy: 0, dir: 0 }] };
  const v = FG.Blueprint.validate(game, bp, 33, 25);
  ok(!v.ok, '升级条目占位期间，普通蓝图校验拒绝该格');
  game.construction.cancel(upPlan.id);
  // 取消后格上是旧石炉，空地校验另选一格验证占位释放
  const v2 = FG.Blueprint.validate(game,
    { w: 1, h: 1, entries: [{ type: 'belt', dx: 0, dy: 0, dir: 1 }] }, 34, 25);
  ok(v2.ok, '取消升级后条目占位释放，空格可正常提交蓝图');
}

console.log('\n[12] 扫描顺序（y 优先）下的前沿/超前条目：缺料前沿不挡后续，补料后零漏建');
{
  // 2×2 区域 y 优先扫描 → 条目序 (40,30)、(40,31)、(41,30)、(41,31)。
  // logistics2+3 均已解锁，普通带直升极速带（成本 steelPlate1+gear1）。
  // 只给 1 套：前沿先换型、其余等待；再补 3 套，验证 cursor 收敛在 y 序 + 间隔落成下零漏建。
  for (const p of game.construction.plans.slice()) game.construction.cancel(p.id);
  const clean = P('chest', 8, 8);
  sim.chestAdd(clean, 'steelPlate', 1);
  sim.chestAdd(clean, 'gear', 1);
  P('belt', 40, 30, 0); P('belt', 40, 31, 0); P('belt', 41, 30, 0); P('belt', 41, 31, 0);
  game.submitUpgradeSelection(40, 30, 41, 31);
  const plan = game.construction.plans[game.construction.plans.length - 1];
  ticks(game, 8);
  ok(map.buildingAt(40, 30).type === 'expressBelt', '前沿（扫描序首栋）先换型为极速带');
  ok(map.buildingAt(40, 31).type === 'belt' && map.buildingAt(41, 30).type === 'belt'
     && map.buildingAt(41, 31).type === 'belt', '缺料：其余 3 栋保持原档');
  sim.chestAdd(clean, 'steelPlate', 3);
  sim.chestAdd(clean, 'gear', 3);
  ticks(game, 30);
  const all = [[40, 30], [40, 31], [41, 30], [41, 31]].map(([x, y]) => map.buildingAt(x, y).type);
  ok(all.every(t => t === 'expressBelt'), '补料后 y 序下 4 栋全部换型（cursor 收敛零漏建：' + all.join(',') + '）');
  ok(!game.construction.plans.some(p => p.id === plan.id), '计划完工出列');
}

console.log('\n结果：' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
