<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import {
  FUELS,
  STATIONS,
  STATUSES,
  useInventoryStore,
  type DeliveryRecord,
  type Fuel,
  type Station
} from "./stores/inventory";

const project = {
  industry: "石油",
  title: "油品配送计划",
  subtitle: "按油站与油品维护罐容和在库量；配送单从待发车、运输中到已到站闭环流转，占用额度与在库量实时联动。",
  stack: ["Vue3", "Vite", "TypeScript", "Pinia", "Element Plus"],
  formTitle: "创建配送单",
  primaryAction: "保存配送单",
  entityLabel: "配送单",
  metricLabels: ["配送单", "运输中", "占用量(吨)"]
} as const;

const store = useInventoryStore();

const filters = ["全部油站", ...STATIONS];
const filter = ref("全部油站");

const form = reactive({
  station: "" as Station | "",
  fuel: "" as Fuel | "",
  tons: "" as number | "",
  arriveAt: "",
  notes: ""
});
const formError = ref<string | null>(null);

const remainingHint = computed(() => {
  if (!form.station || !form.fuel) return null;
  return store.remainingCapacity(form.station, form.fuel);
});

function submit() {
  const error = store.createDelivery({
    station: form.station,
    fuel: form.fuel,
    tons: Number(form.tons),
    arriveAt: form.arriveAt,
    notes: form.notes.trim()
  });
  formError.value = error;
  if (error) return;
  form.station = "";
  form.fuel = "";
  form.tons = "";
  form.arriveAt = "";
  form.notes = "";
}

const filteredRecords = computed(() => {
  if (filter.value === "全部油站") return store.records;
  return store.records.filter((record) => record.station === filter.value);
});

const metrics = computed(() => [store.activeRecords.length, store.inTransitCount, store.totalOccupied]);

const chartRows = computed(() =>
  STATUSES.map((status) => ({
    status,
    value: store.records.filter((record) => record.status === status).length
  }))
);

const maxChart = computed(() => Math.max(1, ...chartRows.value.map((row) => row.value)));

const statusClass: Record<string, string> = {
  待发车: "st-pending",
  运输中: "st-transit",
  已到站: "st-arrived",
  已取消: "st-cancelled"
};

const editing = reactive<{
  station: Station | null;
  fuel: Fuel | null;
  capacity: number;
  stock: number;
  error: string | null;
}>({
  station: null,
  fuel: null,
  capacity: 0,
  stock: 0,
  error: null
});

function startEdit(station: Station, fuel: Fuel) {
  const tank = store.tanks[station][fuel];
  editing.station = station;
  editing.fuel = fuel;
  editing.capacity = tank.capacity;
  editing.stock = tank.stock;
  editing.error = null;
}

function saveEdit() {
  if (!editing.station || !editing.fuel) return;
  const error = store.updateTank(editing.station, editing.fuel, Number(editing.capacity), Number(editing.stock));
  editing.error = error;
  if (!error) {
    editing.station = null;
    editing.fuel = null;
  }
}

function cancelEdit() {
  editing.station = null;
  editing.fuel = null;
  editing.error = null;
}

function isEditing(station: Station, fuel: Fuel) {
  return editing.station === station && editing.fuel === fuel;
}

function stationTotals(station: Station) {
  const tanks = FUELS.map((fuel) => store.tanks[station][fuel]);
  return {
    capacity: tanks.reduce((sum, tank) => sum + tank.capacity, 0),
    stock: Math.round(tanks.reduce((sum, tank) => sum + tank.stock, 0) * 10) / 10
  };
}

function primaryText(record: DeliveryRecord) {
  return `${record.station} / ${record.fuel} / ${record.tons} 吨`;
}
</script>

<template>
  <main class="app">
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">{{ project.industry }}行业 · 油站库存闭环</p>
          <h1>{{ project.title }}</h1>
          <p class="subtitle">{{ project.subtitle }}</p>
        </div>
        <div class="stack">
          <span v-for="item in project.stack" :key="item" class="tag">{{ item }}</span>
        </div>
      </header>

      <section class="metrics">
        <article v-for="(label, index) in project.metricLabels" :key="label" class="metric">
          <span>{{ label }}</span>
          <strong>{{ metrics[index] }}</strong>
        </article>
      </section>

      <section class="board-head">
        <h2>油站库存看板</h2>
        <div class="legend">
          <span><i class="swatch swatch-stock" />在库量</span>
          <span><i class="swatch swatch-occupied" />占用量(在途)</span>
          <span><i class="swatch swatch-free" />剩余罐容</span>
        </div>
      </section>

      <section class="tank-board">
        <article v-for="station in STATIONS" :key="station" class="panel station-card">
          <div class="station-head">
            <h2>{{ station }}</h2>
            <span class="station-total">
              在库 {{ stationTotals(station).stock }} / 罐容 {{ stationTotals(station).capacity }} 吨
            </span>
          </div>
          <div class="table-scroll">
            <table class="tank-table">
              <thead>
                <tr>
                  <th>油品</th>
                  <th>罐容(吨)</th>
                  <th>在库(吨)</th>
                  <th>占用(吨)</th>
                  <th>剩余可配送(吨)</th>
                  <th class="bar-col">库存示意</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                <template v-for="fuel in FUELS" :key="fuel">
                  <tr>
                    <td>{{ fuel }}</td>
                    <td>{{ store.tanks[station][fuel].capacity }}</td>
                    <td>{{ store.tanks[station][fuel].stock }}</td>
                    <td>{{ store.occupiedTons(station, fuel) }}</td>
                    <td :class="{ 'remaining-zero': store.remainingCapacity(station, fuel) <= 0 }">
                      {{ store.remainingCapacity(station, fuel) }}
                    </td>
                    <td class="bar-col">
                      <div class="tank-bar">
                        <div
                          class="tank-stock"
                          :style="{ width: `${(store.tanks[station][fuel].stock / store.tanks[station][fuel].capacity) * 100}%` }"
                        />
                        <div
                          class="tank-occupied"
                          :style="{ width: `${(store.occupiedTons(station, fuel) / store.tanks[station][fuel].capacity) * 100}%` }"
                        />
                      </div>
                    </td>
                    <td>
                      <button class="secondary small" type="button" @click="startEdit(station, fuel)">维护</button>
                    </td>
                  </tr>
                  <tr v-if="isEditing(station, fuel)" class="edit-row">
                    <td colspan="7">
                      <div class="edit-tank">
                        <label>
                          罐容(吨)
                          <input v-model.number="editing.capacity" type="number" min="0" step="0.1" />
                        </label>
                        <label>
                          在库量(吨)
                          <input v-model.number="editing.stock" type="number" min="0" step="0.1" />
                        </label>
                        <button type="button" @click="saveEdit">保存</button>
                        <button class="secondary" type="button" @click="cancelEdit">取消</button>
                        <span class="hint">在途占用 {{ store.occupiedTons(station, fuel) }} 吨，需保留额度</span>
                      </div>
                      <p v-if="editing.error" class="error">{{ editing.error }}</p>
                    </td>
                  </tr>
                </template>
              </tbody>
            </table>
          </div>
        </article>
      </section>

      <section class="workspace">
        <form class="panel" @submit.prevent="submit">
          <h2>{{ project.formTitle }}</h2>
          <div class="form-grid">
            <label>
              目标油站
              <select v-model="form.station" required>
                <option value="">请选择</option>
                <option v-for="station in STATIONS" :key="station">{{ station }}</option>
              </select>
            </label>
            <label>
              油品
              <select v-model="form.fuel" required>
                <option value="">请选择</option>
                <option v-for="fuel in FUELS" :key="fuel">{{ fuel }}</option>
              </select>
            </label>
            <label>
              配送吨数
              <input v-model.number="form.tons" type="number" min="0" step="0.1" required placeholder="请输入吨数" />
            </label>
            <label>
              计划到达
              <input v-model="form.arriveAt" type="date" required />
            </label>
            <p v-if="remainingHint !== null" class="hint">
              {{ form.station }} {{ form.fuel }} 剩余可配送 {{ remainingHint }} 吨（待发车与运输中均计入占用）
            </p>
            <label>
              备注
              <textarea v-model="form.notes" placeholder="填写处理说明或现场备注" />
            </label>
            <p v-if="formError" class="error">{{ formError }}</p>
            <button type="submit">{{ project.primaryAction }}</button>
          </div>
        </form>

        <section class="list-panel">
          <div class="toolbar">
            <h2>{{ project.entityLabel }}列表</h2>
            <select v-model="filter">
              <option v-for="item in filters" :key="item">{{ item }}</option>
            </select>
          </div>

          <div class="record-grid">
            <div v-if="filteredRecords.length === 0" class="empty">暂无匹配数据</div>
            <article v-for="record in filteredRecords" :key="record.id" class="record">
              <div class="record-head">
                <p class="record-title">{{ primaryText(record) }}</p>
                <span class="status" :class="statusClass[record.status]">{{ record.status }}</span>
              </div>
              <div class="details">
                <span>目标油站: {{ record.station }}</span>
                <span>油品: {{ record.fuel }}</span>
                <span>配送吨数: {{ record.tons }}</span>
                <span>计划到达: {{ record.arriveAt }}</span>
              </div>
              <p class="note">{{ record.notes }}</p>
              <div class="actions">
                <template v-if="record.status === '待发车'">
                  <button type="button" @click="store.depart(record.id)">发车</button>
                  <button class="danger" type="button" @click="store.cancel(record.id)">取消配送</button>
                </template>
                <template v-else-if="record.status === '运输中'">
                  <button type="button" @click="store.arrive(record.id)">确认到站</button>
                  <button class="danger" type="button" @click="store.cancel(record.id)">取消配送</button>
                </template>
                <span v-else-if="record.status === '已到站'" class="action-hint">已到站，库存已入账，不可作废</span>
                <span v-else class="action-hint">已取消，占用额度已释放</span>
              </div>
            </article>
          </div>

          <div class="mini-chart">
            <div v-for="row in chartRows" :key="row.status" class="bar">
              <span>{{ row.status }}</span>
              <div class="bar-track"><div class="bar-fill" :style="{ width: `${(row.value / maxChart) * 100}%` }" /></div>
              <strong>{{ row.value }}</strong>
            </div>
          </div>
        </section>
      </section>
    </div>
  </main>
</template>
