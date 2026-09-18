export const STATIONS = ["城东站", "机场站", "新区站"] as const;
export const FUELS = ["92号汽油", "95号汽油", "柴油"] as const;

export type DeliveryStatus = "待发车" | "运输中" | "已到站" | "已取消";

/** 仍占用罐容的状态：待发车与运输中都计入占用额度 */
export const ACTIVE_STATUSES: DeliveryStatus[] = ["待发车", "运输中"];
export const ALL_STATUSES: DeliveryStatus[] = ["待发车", "运输中", "已到站", "已取消"];

export interface Tank {
  station: string;
  fuel: string;
  /** 罐容（吨），可由调度员维护 */
  capacity: number;
  /** 期初在库（吨）；当前在库 = 期初在库 + 已到站累计 */
  initialStock: number;
}

export type DeliveryEventType = "创建" | "发车" | "到站" | "取消";

export interface DeliveryEvent {
  type: DeliveryEventType;
  at: string;
}

export interface Delivery {
  id: string;
  station: string;
  fuel: string;
  /** 配送吨数 */
  tons: number;
  /** 计划到达日期 yyyy-MM-dd */
  arriveAt: string;
  status: DeliveryStatus;
  notes: string;
  createdAt: string;
  /** 流转轨迹，保证每一步状态变化可追溯 */
  events: DeliveryEvent[];
}

export interface PersistedState {
  version: number;
  tanks: Tank[];
  deliveries: Delivery[];
}

export function tankKey(station: string, fuel: string): string {
  return `${station}__${fuel}`;
}

/** 保留两位小数，规避浮点累加误差 */
export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
