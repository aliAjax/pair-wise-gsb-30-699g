// 闭环规则验证：用 Node + Pinia 直接跑真实 store
import { createPinia, setActivePinia } from "pinia";
import { useInventoryStore } from "../src/store";

// ---- 浏览器环境垫片 ----
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear()
};
Object.defineProperty(globalThis, "crypto", {
  value: { randomUUID: () => `id-${Math.random().toString(36).slice(2)}` },
  configurable: true
});

let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.error(`  ❌ ${name} ${extra}`);
  }
}

function freshStore() {
  mem.clear(); // 每个用例从种子数据重新开始
  setActivePinia(createPinia());
  return useInventoryStore();
}

// 初始种子：城东站/92 = 运输中18；机场站/柴油 = 待发车12；各罐 capacity 50 / 期初 12
{
  const s = freshStore();
  const cd92 = s.view("城东站", "92号汽油");
  check("种子: 城东站92 在库12", cd92.stock === 12, `got ${cd92.stock}`);
  check("种子: 城东站92 占用18(运输中)", cd92.occupied === 18, `got ${cd92.occupied}`);
  check("种子: 城东站92 剩余20", cd92.available === 20, `got ${cd92.available}`);
  const jc = s.view("机场站", "柴油");
  check("种子: 机场站柴油 待发车12计入占用", jc.occupied === 12 && jc.available === 26,
    `occ=${jc.occupied} avail=${jc.available}`);
}

// 1. 建单不得超过剩余罐容
{
  const s = freshStore();
  const r1 = s.createDelivery({ station: "城东站", fuel: "92号汽油", tons: 20, arriveAt: "2026-09-20", notes: "" });
  check("恰好等于剩余罐容20 → 允许", r1.ok === true, JSON.stringify(r1));
  const v1 = s.view("城东站", "92号汽油");
  check("建单后占用 = 18+20 = 38", v1.occupied === 38, `got ${v1.occupied}`);
  check("建单后剩余 = 0", v1.available === 0, `got ${v1.available}`);

  const r2 = s.createDelivery({ station: "城东站", fuel: "92号汽油", tons: 0.1, arriveAt: "2026-09-20", notes: "" });
  check("再超0.1吨 → 拒绝", r2.ok === false);

  const r3 = s.createDelivery({ station: "机场站", fuel: "柴油", tons: 27, arriveAt: "x", notes: "" });
  check("机场站柴油27 > 剩余26 → 拒绝", r3.ok === false);
  const r4 = s.createDelivery({ station: "机场站", fuel: "柴油", tons: 26, arriveAt: "x", notes: "" });
  check("机场站柴油26 恰好 → 允许", r4.ok === true, JSON.stringify(r4));

  const r5 = s.createDelivery({ station: "城东站", fuel: "95号汽油", tons: -3, arriveAt: "x", notes: "" });
  check("负数吨数 → 拒绝", r5.ok === false);
  const r6 = s.createDelivery({ station: "城东站", fuel: "95号汽油", tons: 0, arriveAt: "x", notes: "" });
  check("零吨 → 拒绝", r6.ok === false);
}

// 2. 状态机：只有待发车能发车，只有运输中能到站
{
  const s = freshStore();
  const pending = s.deliveries.find((d) => d.status === "待发车");
  check("待发车不能直接到站", s.arrive(pending.id).ok === false);
  check("待发车发车 → 成功", s.depart(pending.id).ok === true);
  check("运输中重复发车 → 拒绝", s.depart(pending.id).ok === false);
  const arrivedBefore = s.view(pending.station, pending.fuel).arrived;
  check("运输中到站 → 成功", s.arrive(pending.id).ok === true);
  const v = s.view(pending.station, pending.fuel);
  check("到站后在库 += 12 (12→24)", v.stock === 24, `got ${v.stock}`);
  check("到站后占用释放 (→0)", v.occupied === 0, `got ${v.occupied}`);
  check("到站累计 +12", v.arrived === arrivedBefore + 12, `got ${v.arrived}`);
  check("已到站重复到站 → 拒绝", s.arrive(pending.id).ok === false);
}

// 3. 取消：未到站释放额度；已到站不能作废
{
  const s = freshStore();
  const transit = s.deliveries.find((d) => d.status === "运输中"); // 城东站92, 18吨
  check("运输中取消 → 成功", s.cancel(transit.id).ok === true);
  const v = s.view("城东站", "92号汽油");
  check("取消运输中 → 占用释放", v.occupied === 0, `got ${v.occupied}`);
  check("取消运输中 → 在库不变(12)", v.stock === 12, `got ${v.stock}`);
  check("已取消再取消 → 拒绝", s.cancel(transit.id).ok === false);

  const pending = s.deliveries.find((d) => d.status === "待发车");
  s.depart(pending.id);
  s.arrive(pending.id);
  check("已到站不能作废", s.cancel(pending.id).ok === false);
  const v2 = s.view(pending.station, pending.fuel);
  check("作废被拒后在库仍含到站量", v2.stock === 24, `got ${v2.stock}`);
}

// 4. 完整链路后释放的额度可被新单使用
{
  const s = freshStore();
  const transit = s.deliveries.find((d) => d.status === "运输中");
  s.cancel(transit.id); // 释放18 → 城东站92 available: 50-12=38
  const v0 = s.view("城东站", "92号汽油");
  check("取消后剩余38", v0.available === 38, `got ${v0.available}`);
  check("释放额度可排产38", s.createDelivery({
    station: "城东站", fuel: "92号汽油", tons: 38, arriveAt: "x", notes: ""
  }).ok === true);
}

// 5. 到站不能爆罐（建单已卡住，防御校验仍生效）
{
  const s = freshStore();
  const pending = s.deliveries.find((d) => d.status === "待发车"); // 机场站柴油12
  // 把罐容调到刚好容纳：在库12 + 占用12 = 24，下限24；调24合法
  check("罐容下调至下限24 → 允许", s.setCapacity("机场站", "柴油", 24).ok === true);
  s.depart(pending.id);
  check("到站后正好满罐 → 允许", s.arrive(pending.id).ok === true);
  check("在库24 = 罐容24", s.view("机场站", "柴油").stock === 24);

  const low = s.setCapacity("城东站", "92号汽油", 29); // 在库12+占用18=30
  check("罐容低于在库+占用 → 拒绝", low.ok === false);
  check("非法罐容不生效，仍为50", s.view("城东站", "92号汽油").capacity === 50);
}

// 6. 刷新（重新从 localStorage 加载）后数据一致
{
  const s = freshStore();
  const d = s.deliveries.find((x) => x.status === "待发车");
  s.depart(d.id);
  s.arrive(d.id);
  s.createDelivery({ station: "新区站", fuel: "95号汽油", tons: 10, arriveAt: "2026-10-01", notes: "刷新测试" });

  // 模拟刷新：新 pinia、不清存储，重新走 loadState
  setActivePinia(createPinia());
  const s2 = useInventoryStore();
  const v = s2.view("机场站", "柴油");
  check("刷新后到站在库持久化(24)", v.stock === 24, `got ${v.stock}`);
  check("刷新后占用持久化(0)", v.occupied === 0, `got ${v.occupied}`);
  const xq = s2.view("新区站", "95号汽油");
  check("刷新后新单占用持久化(10)", xq.occupied === 10 && xq.available === 28,
    `occ=${xq.occupied} avail=${xq.available}`);
  check("刷新后所有油罐恒等式成立: 在库+占用 ≤ 罐容",
    s2.tankViews.every((t) => t.stock + t.occupied <= t.capacity + 1e-9));
  check("刷新后剩余 = 罐容-在库-占用",
    s2.tankViews.every((t) => Math.abs(t.available - (t.capacity - t.stock - t.occupied)) < 1e-9));
  const arrived = s2.deliveries.find((x) => x.id === d.id);
  check("刷新后到站单状态仍为已到站且无删除入口", arrived.status === "已到站");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
