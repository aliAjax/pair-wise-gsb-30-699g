import { defineStore } from "pinia";
import { computed, ref } from "vue";
import {
  ACTIVE_STATUSES,
  ALL_STATUSES,
  FUELS,
  STATIONS,
  type Delivery,
  type DeliveryStatus,
  type PersistedState,
  type Tank,
  round2,
  tankKey
} from "./types";

const STORAGE_KEY = "hxwlfront-19-oil-delivery-v2";
const STATE_VERSION = 2;

/** 每个油站每种油品一罐，默认罐容 50 吨、期初在库 12 吨 */
function seedTanks(): Tank[] {
  return STATIONS.flatMap((station) =>
    FUELS.map((fuel) => ({ station, fuel, capacity: 50, initialStock: 12 }))
  );
}

function seedDeliveries(): Delivery[] {
  const now = Date.now();
  const iso = (offsetDays: number) => new Date(now - offsetDays * 86400000).toISOString();
  return [
    {
      id: "seed-1",
      station: "城东站",
      fuel: "92号汽油",
      tons: 18,
      arriveAt: isoDate(2),
      status: "运输中",
      notes: "车辆已出库",
      createdAt: iso(1),
      events: [
        { type: "创建", at: iso(1) },
        { type: "发车", at: iso(0) }
      ]
    },
    {
      id: "seed-2",
      station: "机场站",
      fuel: "柴油",
      tons: 12,
      arriveAt: isoDate(3),
      status: "待发车",
      notes: "等待装车",
      createdAt: iso(0),
      events: [{ type: "创建", at: iso(0) }]
    }
  ];
}

function isoDate(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
}

/** 加载并归一化：兼容旧版本/脏数据，保证台账恒等式成立 */
function loadState(): PersistedState {
  let tanks = seedTanks();
  let deliveries: Delivery[] = seedDeliveries();

  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<PersistedState>;
      if (Array.isArray(parsed.tanks) && parsed.tanks.length > 0) {
        tanks = parsed.tanks.map(normalizeTank).filter((t): t is Tank => t !== null);
        // 补齐新增油站/油品的油罐
        const keys = new Set(tanks.map((t) => tankKey(t.station, t.fuel)));
        for (const seed of seedTanks()) {
          if (!keys.has(tankKey(seed.station, seed.fuel))) tanks.push(seed);
        }
      }
      if (Array.isArray(parsed.deliveries)) {
        deliveries = parsed.deliveries
          .map(normalizeDelivery)
          .filter((d): d is Delivery => d !== null);
      }
    } catch {
      // 数据损坏时回退到种子数据
    }
  }

  return { version: STATE_VERSION, tanks, deliveries };
}

function normalizeTank(raw: unknown): Tank | null {
  if (typeof raw !== "object" || raw === null) return null;
  const t = raw as Record<string, unknown>;
  if (typeof t.station !== "string" || typeof t.fuel !== "string") return null;
  const capacity = positiveNumber(t.capacity, 50);
  const initialStock = Math.max(0, finiteNumber(t.initialStock, 12));
  return {
    station: t.station,
    fuel: t.fuel,
    capacity,
    initialStock: Math.min(initialStock, capacity)
  };
}

function normalizeDelivery(raw: unknown): Delivery | null {
  if (typeof raw !== "object" || raw === null) return null;
  const d = raw as Record<string, unknown>;
  if (typeof d.station !== "string" || typeof d.fuel !== "string") return null;
  const status: DeliveryStatus = ALL_STATUSES.includes(d.status as DeliveryStatus)
    ? (d.status as DeliveryStatus)
    : "待发车";
  return {
    id: typeof d.id === "string" ? d.id : crypto.randomUUID(),
    station: d.station,
    fuel: d.fuel,
    tons: positiveNumber(d.tons, 0),
    arriveAt: typeof d.arriveAt === "string" ? d.arriveAt : "",
    status,
    notes: typeof d.notes === "string" ? d.notes : "",
    createdAt: typeof d.createdAt === "string" ? d.createdAt : new Date().toISOString(),
    events: Array.isArray(d.events) ? (d.events as Delivery["events"]) : []
  };
}

const ALL: readonly string[] = ["待发车", "运输中", "已到站", "已取消"];

function finiteNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function positiveNumber(value: unknown, fallback: number): number {
  const n = finiteNumber(value, fallback);
  return n > 0 ? n : fallback;
}

export interface TankView {
  station: string;
  fuel: string;
  capacity: number;
  initialStock: number;
  /** 当前在库 = 期初在库 + 已到站累计 */
  stock: number;
  /** 待发车 + 运输中 的计划量 */
  occupied: number;
  /** 剩余可排产罐容 */
  available: number;
  /** 已到站累计 */
  arrived: number;
  /** 罐容使用率（在库+占用）/罐容 */
  usageRatio: number;
}

export const useInventoryStore = defineStore("oil-inventory", () => {
  const initial = loadState();
  const tanks = ref<Tank[]>(initial.tanks);
  const deliveries = ref<Delivery[]>(initial.deliveries);

  function persist() {
    const state: PersistedState = {
      version: STATE_VERSION,
      tanks: tanks.value,
      deliveries: deliveries.value
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  const tankMap = computed(() => {
    const map = new Map<string, Tank>();
    for (const t of tanks.value) map.set(tankKey(t.station, t.fuel), t);
    return map;
  });

  function sumTons(station: string, fuel: string, statuses: DeliveryStatus[]): number {
    return round2(
      deliveries.value
        .filter((d) => d.station === station && d.fuel === fuel && statuses.includes(d.status))
        .reduce((acc, d) => acc + d.tons, 0)
    );
  }

  const tankViews = computed<TankView[]>(() =>
    tanks.value.map((t) => {
      const arrived = sumTons(t.station, t.fuel, ["已到站"]);
      const stock = round2(t.initialStock + arrived);
      const occupied = sumTons(t.station, t.fuel, ACTIVE_STATUSES);
      const available = round2(t.capacity - stock - occupied);
      return {
        ...t,
        stock,
        occupied,
        available,
        arrived,
        usageRatio: t.capacity > 0 ? Math.min(1, (stock + occupied) / t.capacity) : 0
      };
    })
  );

  function view(station: string, fuel: string): TankView | undefined {
    return tankViews.value.find((t) => t.station === station && t.fuel === fuel);
  }

  /** 创建配送单：不得超过剩余罐容（待发车+运输中均已计入占用） */
  function createDelivery(input: {
    station: string;
    fuel: string;
    tons: number;
    arriveAt: string;
    notes: string;
  }): { ok: true } | { ok: false; message: string } {
    const tons = round2(Number(input.tons));
    if (!(tons > 0)) return { ok: false, message: "配送吨数必须大于 0" };

    const tank = tankMap.value.get(tankKey(input.station, input.fuel));
    if (!tank) return { ok: false, message: "该油站未维护此油品的油罐" };

    const current = view(input.station, input.fuel);
    if (!current) return { ok: false, message: "油罐台账不存在" };
    if (round2(tons - current.available) > 0) {
      return {
        ok: false,
        message: `超出剩余罐容：当前在库 ${current.stock} 吨，已占用 ${current.occupied} 吨，仅剩 ${current.available} 吨可排产`
      };
    }

    const now = new Date().toISOString();
    const delivery: Delivery = {
      id: crypto.randomUUID(),
      station: input.station,
      fuel: input.fuel,
      tons,
      arriveAt: input.arriveAt,
      status: "待发车",
      notes: input.notes || "暂无备注",
      createdAt: now,
      events: [{ type: "创建", at: now }]
    };
    deliveries.value = [delivery, ...deliveries.value];
    persist();
    return { ok: true };
  }

  /** 待发车 → 运输中，仅此一条路可进入运输中 */
  function depart(id: string): { ok: boolean; message?: string } {
    const d = deliveries.value.find((item) => item.id === id);
    if (!d) return { ok: false, message: "配送单不存在" };
    if (d.status !== "待发车") return { ok: false, message: "只有待发车单据可以发车" };
    d.status = "运输中";
    d.events.push({ type: "发车", at: new Date().toISOString() });
    persist();
    return { ok: true };
  }

  /** 运输中 → 已到站：释放占用，吨数进入在库量 */
  function arrive(id: string): { ok: boolean; message?: string } {
    const d = deliveries.value.find((item) => item.id === id);
    if (!d) return { ok: false, message: "配送单不存在" };
    if (d.status !== "运输中") return { ok: false, message: "只有运输中单据可以确认到站" };

    const tank = tankMap.value.get(tankKey(d.station, d.fuel));
    if (!tank) return { ok: false, message: "油罐台账不存在" };
    const current = view(d.station, d.fuel);
    // 占用释放后入库：stock + tons 必然不超过罐容（建单时已校验），这里再防御一次
    if (current && round2(current.stock + d.tons - tank.capacity) > 0) {
      return {
        ok: false,
        message: "到站后在库将超过罐容，请先核对罐容或库存台账"
      };
    }

    d.status = "已到站";
    d.events.push({ type: "到站", at: new Date().toISOString() });
    persist();
    return { ok: true };
  }

  /** 取消未到站单据：待发车/运输中可取消并释放占用；已到站不可回退 */
  function cancel(id: string): { ok: boolean; message?: string } {
    const d = deliveries.value.find((item) => item.id === id);
    if (!d) return { ok: false, message: "配送单不存在" };
    if (d.status === "已到站") return { ok: false, message: "已到站记录不能作废回退库存" };
    if (d.status === "已取消") return { ok: false, message: "单据已取消" };

    d.status = "已取消";
    d.events.push({ type: "取消", at: new Date().toISOString() });
    persist();
    return { ok: true };
  }

  /** 维护罐容：不得低于 当前在库 + 占用，保证库存恒等式不被破坏 */
  function setCapacity(station: string, fuel: string, capacity: number): { ok: boolean; message?: string } {
    const tank = tankMap.value.get(tankKey(station, fuel));
    if (!tank) return { ok: false, message: "油罐台账不存在" };
    const next = round2(Number(capacity));
    if (!(next > 0)) return { ok: false, message: "罐容必须大于 0" };
    const current = view(station, fuel);
    const floor = current ? round2(current.stock + current.occupied) : 0;
    if (next < floor) {
      return {
        ok: false,
        message: `罐容不能低于在库与占用之和 ${floor} 吨`
      };
    }
    tank.capacity = next;
    persist();
    return { ok: true };
  }

  function resetDemo() {
    tanks.value = seedTanks();
    deliveries.value = seedDeliveries();
    persist();
  }

  return {
    tanks,
    deliveries,
    tankViews,
    view,
    createDelivery,
    depart,
    arrive,
    cancel,
    setCapacity,
    resetDemo
  };
});
