/* 油站库存闭环逻辑验证：直接驱动 Pinia store，覆盖需求规则 */
import { createPinia, setActivePinia } from "pinia";
import { useInventoryStore } from "../src/stores/inventory.ts";

// localStorage 内存模拟（store 仅在首次使用时读取，先装 shim 即可）
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear()
};
globalThis.crypto ??= {};
globalThis.crypto.randomUUID ??= () => `id-${Math.random().toString(36).slice(2)}`;

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ok  - ${name}`); }
  else { failed++; console.error(`  FAIL - ${name}`); }
}

function freshStore() {
  mem.clear();
  setActivePinia(createPinia());
  return useInventoryStore();
}

// 1. 种子数据一致性：罐容 >= 在库 + 占用
{
  const s = freshStore();
  for (const st of ["城东站", "机场站", "新区站"]) {
    for (const f of ["92号汽油", "95号汽油", "柴油"]) {
      const t = s.tanks[st][f];
      check(`种子 ${st}/${f} 罐容>=在库+占用`, t.capacity >= t.stock + s.occupiedTons(st, f));
    }
  }
}

// 2. 新建配送单不得超过剩余罐容；待发车和运输中都计入占用
{
  const s = freshStore();
  // 城东站 92号: cap60 stock20 占用18(种子运输中) => 剩余22
  check("剩余额度=罐容-在库-占用", s.remainingCapacity("城东站", "92号汽油") === 22);
  check("超量建单被拒绝", s.createDelivery({ station: "城东站", fuel: "92号汽油", tons: 22.1, arriveAt: "2026-09-20", notes: "" }) !== null);
  check("等额建单成功", s.createDelivery({ station: "城东站", fuel: "92号汽油", tons: 22, arriveAt: "2026-09-20", notes: "" }) === null);
  check("待发车计入占用", s.remainingCapacity("城东站", "92号汽油") === 0);
  check("占满后再建单被拒绝", s.createDelivery({ station: "城东站", fuel: "92号汽油", tons: 0.1, arriveAt: "2026-09-20", notes: "" }) !== null);
  check("吨数必须为正", s.createDelivery({ station: "城东站", fuel: "92号汽油", tons: 0, arriveAt: "2026-09-20", notes: "" }) !== null);
  check("负数被拒绝", s.createDelivery({ station: "城东站", fuel: "92号汽油", tons: -5, arriveAt: "2026-09-20", notes: "" }) !== null);
  check("缺油站被拒绝", s.createDelivery({ station: "", fuel: "92号汽油", tons: 1, arriveAt: "2026-09-20", notes: "" }) !== null);
}

// 3. 状态机：只允许待发车->运输中，只有运输中->已到站
{
  const s = freshStore();
  s.createDelivery({ station: "新区站", fuel: "柴油", tons: 5, arriveAt: "2026-09-20", notes: "" });
  const rec = s.records[0];
  check("新单为待发车", rec.status === "待发车");
  s.arrive(rec.id); // 待发车不能直接到站
  check("待发车不能确认到站", rec.status === "待发车");
  s.depart(rec.id);
  check("待发车可发车", rec.status === "运输中");
  s.depart(rec.id); // 运输中不能再次发车
  check("运输中不能重复发车", rec.status === "运输中");
  const before = s.tanks["新区站"]["柴油"].stock;
  s.arrive(rec.id);
  check("运输中可确认到站", rec.status === "已到站");
  check("到站后在库量增加", s.tanks["新区站"]["柴油"].stock === before + 5);
  check("到站后占用释放", s.occupiedTons("新区站", "柴油") === 0);
  s.depart(rec.id); // 已到站不能回退
  check("已到站不能回退发车", rec.status === "已到站");
  s.cancel(rec.id); // 已到站不能取消
  check("已到站不能作废", rec.status === "已到站");
  check("已到站在库不回退", s.tanks["新区站"]["柴油"].stock === before + 5);
}

// 4. 取消未到站配送单释放额度
{
  const s = freshStore();
  s.createDelivery({ station: "机场站", fuel: "95号汽油", tons: 10, arriveAt: "2026-09-20", notes: "" });
  const rec = s.records[0];
  check("建单后占用10", s.occupiedTons("机场站", "95号汽油") === 10);
  s.cancel(rec.id);
  check("取消待发车后状态为已取消", rec.status === "已取消");
  check("取消后占用释放", s.occupiedTons("机场站", "95号汽油") === 0);
  s.cancel(rec.id); // 已取消不能重复取消
  check("已取消保持终态", rec.status === "已取消");

  s.createDelivery({ station: "机场站", fuel: "95号汽油", tons: 8, arriveAt: "2026-09-21", notes: "" });
  const rec2 = s.records[0];
  s.depart(rec2.id);
  check("运输中占用8", s.occupiedTons("机场站", "95号汽油") === 8);
  s.cancel(rec2.id);
  check("取消运输中释放占用", s.occupiedTons("机场站", "95号汽油") === 0);
  check("取消运输中不影响在库", s.tanks["机场站"]["95号汽油"].stock === 12);
}

// 5. 罐容/在库维护校验
{
  const s = freshStore();
  // 机场站 柴油: cap45 stock8 占用12(种子待发车)
  check("罐容小于在库+占用被拒绝", s.updateTank("机场站", "柴油", 19, 8) !== null);
  check("罐容等于在库+占用可保存", s.updateTank("机场站", "柴油", 20, 8) === null);
  check("在库为负被拒绝", s.updateTank("机场站", "柴油", 45, -1) !== null);
  check("在库+占用超罐容被拒绝", s.updateTank("机场站", "柴油", 20, 9) !== null);
}

// 6. 刷新一致性：持久化后重建 store，罐容/在库/占用/状态一致
{
  mem.clear();
  setActivePinia(createPinia());
  const s1 = useInventoryStore();
  s1.createDelivery({ station: "城东站", fuel: "柴油", tons: 6, arriveAt: "2026-09-20", notes: "" });
  const pending = s1.records[0];
  s1.depart(pending.id);
  s1.createDelivery({ station: "城东站", fuel: "柴油", tons: 4, arriveAt: "2026-09-21", notes: "" });
  const arrivedSeed = s1.records.find((r) => r.id === "seed-1");
  s1.arrive(arrivedSeed.id); // 城东站92号 +18
  const snapshot = {
    tanks: JSON.parse(JSON.stringify(s1.tanks)),
    records: JSON.parse(JSON.stringify(s1.records)),
    occupied: s1.occupiedTons("城东站", "柴油")
  };

  setActivePinia(createPinia());
  const s2 = useInventoryStore(); // 模拟刷新后重新加载
  check("刷新后罐容一致", JSON.stringify(s2.tanks) === JSON.stringify(snapshot.tanks));
  check("刷新后配送状态一致", JSON.stringify(s2.records) === JSON.stringify(snapshot.records));
  check("刷新后占用一致", s2.occupiedTons("城东站", "柴油") === snapshot.occupied);
  check("刷新后在库含到站入账", s2.tanks["城东站"]["92号汽油"].stock === 38);
  check("刷新后剩余额度一致", s2.remainingCapacity("城东站", "柴油") === 40 - 10 - (6 + 4));
}

// 7. 旧版本/脏数据回退种子
{
  mem.clear();
  mem.set("hxwlfront-19-oil-delivery", JSON.stringify([{ id: "old" }])); // 旧格式数组
  setActivePinia(createPinia());
  const s = useInventoryStore();
  check("旧格式数据回退种子", s.records.length === 2 && s.records[0].id === "seed-1");
  mem.set("hxwlfront-19-oil-delivery", "{broken json");
  setActivePinia(createPinia());
  const s2 = useInventoryStore();
  check("脏数据回退种子", s2.records.length === 2);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
