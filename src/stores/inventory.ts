import { computed, ref } from "vue";
import { defineStore } from "pinia";

export const STATIONS = ["城东站", "机场站", "新区站"] as const;
export const FUELS = ["92号汽油", "95号汽油", "柴油"] as const;
export const STATUSES = ["待发车", "运输中", "已到站", "已取消"] as const;

export type Station = (typeof STATIONS)[number];
export type Fuel = (typeof FUELS)[number];
export type Status = (typeof STATUSES)[number];

export interface DeliveryRecord {
  id: string;
  station: Station;
  fuel: Fuel;
  tons: number;
  arriveAt: string;
  status: Status;
  notes: string;
  createdAt: string;
}

export interface Tank {
  /** 罐容（吨） */
  capacity: number;
  /** 在库量（吨） */
  stock: number;
}

export type TankState = Record<Station, Record<Fuel, Tank>>;

const STORAGE_KEY = "hxwlfront-19-oil-delivery";
const STORAGE_VERSION = 2;

/** 占用罐容的状态：待发车与运输中的计划量都计入占用 */
const OCCUPYING_STATUSES: readonly Status[] = ["待发车", "运输中"];

function seedTanks(): TankState {
  return {
    城东站: {
      "92号汽油": { capacity: 60, stock: 20 },
      "95号汽油": { capacity: 50, stock: 15 },
      柴油: { capacity: 40, stock: 10 }
    },
    机场站: {
      "92号汽油": { capacity: 50, stock: 25 },
      "95号汽油": { capacity: 40, stock: 12 },
      柴油: { capacity: 45, stock: 8 }
    },
    新区站: {
      "92号汽油": { capacity: 45, stock: 18 },
      "95号汽油": { capacity: 35, stock: 10 },
      柴油: { capacity: 35, stock: 12 }
    }
  };
}

function seedRecords(): DeliveryRecord[] {
  return [
    {
      id: "seed-1",
      station: "城东站",
      fuel: "92号汽油",
      tons: 18,
      arriveAt: "2026-07-01",
      status: "运输中",
      notes: "车辆已出库",
      createdAt: new Date(Date.now() - 86400000).toISOString()
    },
    {
      id: "seed-2",
      station: "机场站",
      fuel: "柴油",
      tons: 12,
      arriveAt: "2026-07-01",
      status: "待发车",
      notes: "等待装车",
      createdAt: new Date().toISOString()
    }
  ];
}

interface PersistedState {
  version: number;
  tanks: TankState;
  records: DeliveryRecord[];
}

function seedState(): PersistedState {
  return { version: STORAGE_VERSION, tanks: seedTanks(), records: seedRecords() };
}

function loadState(): PersistedState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return seedState();
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    // 只接受当前版本且结构完整的数据，旧格式或脏数据一律回退种子数据
    if (
      parsed &&
      parsed.version === STORAGE_VERSION &&
      parsed.tanks &&
      Array.isArray(parsed.records) &&
      STATIONS.every((station) => FUELS.every((fuel) => parsed.tanks?.[station]?.[fuel]))
    ) {
      return parsed as PersistedState;
    }
    return seedState();
  } catch {
    return seedState();
  }
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export const useInventoryStore = defineStore("inventory", () => {
  const initial = loadState();
  const tanks = ref<TankState>(initial.tanks);
  const records = ref<DeliveryRecord[]>(initial.records);

  /** 每次变更后整体落盘，保证刷新后罐容/在库/占用/配送状态一致 */
  function persist() {
    const state: PersistedState = { version: STORAGE_VERSION, tanks: tanks.value, records: records.value };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  /** 某油站某油品被在途配送单占用的罐容（待发车 + 运输中） */
  function occupiedTons(station: Station, fuel: Fuel): number {
    return records.value
      .filter((record) => record.station === station && record.fuel === fuel && OCCUPYING_STATUSES.includes(record.status))
      .reduce((sum, record) => sum + Number(record.tons), 0);
  }

  /** 剩余可配送额度 = 罐容 - 在库量 - 占用量 */
  function remainingCapacity(station: Station, fuel: Fuel): number {
    const tank = tanks.value[station][fuel];
    return round1(tank.capacity - tank.stock - occupiedTons(station, fuel));
  }

  const activeRecords = computed(() => records.value.filter((record) => record.status !== "已取消"));

  const totalStock = computed(() =>
    round1(STATIONS.flatMap((station) => FUELS.map((fuel) => tanks.value[station][fuel].stock)).reduce((a, b) => a + b, 0))
  );

  const totalOccupied = computed(() =>
    round1(
      records.value
        .filter((record) => OCCUPYING_STATUSES.includes(record.status))
        .reduce((sum, record) => sum + Number(record.tons), 0)
    )
  );

  const inTransitCount = computed(() => records.value.filter((record) => record.status === "运输中").length);

  /**
   * 新建配送单：计划量不得超过剩余罐容。
   * 返回 null 表示成功，否则返回错误信息。
   */
  function createDelivery(input: { station: Station | ""; fuel: Fuel | ""; tons: number; arriveAt: string; notes: string }): string | null {
    if (!input.station || !input.fuel) return "请选择目标油站和油品";
    const tons = Number(input.tons);
    if (!Number.isFinite(tons) || tons <= 0) return "配送吨数必须大于 0";
    if (!input.arriveAt) return "请选择计划到达日期";
    const remaining = remainingCapacity(input.station, input.fuel);
    if (tons > remaining) {
      return `超出剩余罐容：${input.station} ${input.fuel} 剩余可配送 ${remaining} 吨`;
    }
    records.value = [
      {
        id: crypto.randomUUID(),
        station: input.station,
        fuel: input.fuel,
        tons,
        arriveAt: input.arriveAt,
        status: "待发车",
        notes: input.notes || "暂无备注",
        createdAt: new Date().toISOString()
      },
      ...records.value
    ];
    persist();
    return null;
  }

  /** 发车：只允许待发车进入运输中 */
  function depart(id: string) {
    const record = records.value.find((item) => item.id === id);
    if (!record || record.status !== "待发车") return;
    record.status = "运输中";
    persist();
  }

  /** 确认到站：只有运输中能确认到站，到站后释放占用并增加在库量 */
  function arrive(id: string) {
    const record = records.value.find((item) => item.id === id);
    if (!record || record.status !== "运输中") return;
    record.status = "已到站";
    const tank = tanks.value[record.station][record.fuel];
    tank.stock = round1(tank.stock + Number(record.tons));
    persist();
  }

  /** 取消：仅未到站（待发车/运输中）可取消，取消后占用额度立即释放；已到站不可作废 */
  function cancel(id: string) {
    const record = records.value.find((item) => item.id === id);
    if (!record || !OCCUPYING_STATUSES.includes(record.status)) return;
    record.status = "已取消";
    persist();
  }

  /**
   * 维护罐容与在库量：在库量 + 占用量 不得超过罐容。
   * 返回 null 表示成功，否则返回错误信息。
   */
  function updateTank(station: Station, fuel: Fuel, capacity: number, stock: number): string | null {
    const nextCapacity = Number(capacity);
    const nextStock = Number(stock);
    if (!Number.isFinite(nextCapacity) || nextCapacity <= 0) return "罐容必须大于 0";
    if (!Number.isFinite(nextStock) || nextStock < 0) return "在库量不能为负数";
    const occupied = occupiedTons(station, fuel);
    if (round1(nextStock + occupied) > nextCapacity) {
      return `罐容不足：在库 ${nextStock} 吨 + 占用 ${occupied} 吨 不能超过罐容`;
    }
    tanks.value[station][fuel] = { capacity: nextCapacity, stock: nextStock };
    persist();
    return null;
  }

  return {
    tanks,
    records,
    activeRecords,
    inTransitCount,
    totalStock,
    totalOccupied,
    occupiedTons,
    remainingCapacity,
    createDelivery,
    depart,
    arrive,
    cancel,
    updateTank
  };
});
