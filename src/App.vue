<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { ALL_STATUSES, FUELS, STATIONS, tankKey, type Delivery } from "./types";
import { useInventoryStore } from "./store";

const store = useInventoryStore();

/* ---------------- 罐容维护 ---------------- */

const capacityDrafts = reactive<Record<string, string>>({});
for (const t of store.tankViews) capacityDrafts[tankKey(t.station, t.fuel)] = String(t.capacity);

function saveCapacity(station: string, fuel: string) {
  const key = tankKey(station, fuel);
  const result = store.setCapacity(station, fuel, Number(capacityDrafts[key]));
  if (result.ok) {
    ElMessage.success("罐容已更新");
  } else {
    ElMessage.error(result.message);
    const view = store.view(station, fuel);
    if (view) capacityDrafts[key] = String(view.capacity);
  }
}

/* ---------------- 指标 ---------------- */

const totals = computed(() => {
  const views = store.tankViews;
  return {
    tankCount: views.length,
    capacity: views.reduce((acc, t) => acc + t.capacity, 0),
    stock: views.reduce((acc, t) => acc + t.stock, 0),
    occupied: views.reduce((acc, t) => acc + t.occupied, 0)
  };
});

const activeCount = computed(
  () => store.deliveries.filter((d) => d.status === "待发车" || d.status === "运输中").length
);
const arrivedCount = computed(() => store.deliveries.filter((d) => d.status === "已到站").length);

/* ---------------- 新建配送单 ---------------- */

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

const form = reactive({
  station: "" as string,
  fuel: "" as string,
  tons: "" as string | number,
  arriveAt: today(),
  notes: ""
});

const selectedTank = computed(() =>
  form.station && form.fuel ? store.view(form.station, form.fuel) : undefined
);

const tonsNumber = computed(() => {
  const n = Number(form.tons);
  return Number.isFinite(n) ? n : 0;
});

const formHint = computed(() => {
  const t = selectedTank.value;
  if (!t) return "请先选择目标油站和油品";
  return `罐容 ${t.capacity} 吨 ｜ 在库 ${t.stock} 吨 ｜ 占用 ${t.occupied} 吨 ｜ 剩余可排产 ${t.available} 吨`;
});

const overCapacity = computed(() => {
  const t = selectedTank.value;
  return !!t && tonsNumber.value > 0 && tonsNumber.value > t.available;
});

function submit() {
  if (!form.station || !form.fuel) {
    ElMessage.warning("请选择目标油站和油品");
    return;
  }
  const result = store.createDelivery({
    station: form.station,
    fuel: form.fuel,
    tons: Number(form.tons),
    arriveAt: form.arriveAt,
    notes: form.notes
  });
  if (!result.ok) {
    ElMessage.error(result.message);
    return;
  }
  ElMessage.success("配送单已创建，占用对应罐容额度");
  form.station = "";
  form.fuel = "";
  form.tons = "";
  form.arriveAt = today();
  form.notes = "";
}

/* ---------------- 列表与流转 ---------------- */

const stationFilter = ref("全部油站");
const statusFilter = ref("全部状态");

const filteredDeliveries = computed(() =>
  store.deliveries.filter((d) => {
    const stationOk = stationFilter.value === "全部油站" || d.station === stationFilter.value;
    const statusOk = statusFilter.value === "全部状态" || d.status === statusFilter.value;
    return stationOk && statusOk;
  })
);

function depart(d: Delivery) {
  const result = store.depart(d.id);
  if (result.ok) ElMessage.success("已发车，进入运输中");
  else ElMessage.error(result.message ?? "操作失败");
}

function arrive(d: Delivery) {
  const result = store.arrive(d.id);
  if (result.ok) ElMessage.success(`已确认到站，${d.tons} 吨入库并释放占用`);
  else ElMessage.error(result.message ?? "操作失败");
}

async function cancel(d: Delivery) {
  try {
    await ElMessageBox.confirm(
      `确定取消「${d.station} / ${d.fuel} / ${d.tons} 吨」配送单？取消后释放 ${d.tons} 吨占用额度。`,
      "取消配送单",
      { type: "warning", confirmButtonText: "确认取消", cancelButtonText: "再想想" }
    );
  } catch {
    return;
  }
  const result = store.cancel(d.id);
  if (result.ok) ElMessage.success("配送单已取消，占用额度已释放");
  else ElMessage.error(result.message ?? "操作失败");
}

function eventTime(d: Delivery, type: string): string {
  const event = d.events.find((e) => e.type === type);
  return event ? new Date(event.at).toLocaleString("zh-CN", { hour12: false }) : "—";
}

async function resetDemo() {
  try {
    await ElMessageBox.confirm("将清空本地数据并恢复演示台账，是否继续？", "重置演示数据", {
      type: "warning",
      confirmButtonText: "重置",
      cancelButtonText: "取消"
    });
  } catch {
    return;
  }
  store.resetDemo();
  for (const t of store.tankViews) capacityDrafts[tankKey(t.station, t.fuel)] = String(t.capacity);
  ElMessage.success("已恢复演示数据");
}

const statusCount = (status: string) =>
  store.deliveries.filter((d) => d.status === status).length;
</script>

<template>
  <main class="app">
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">石油行业前端最小闭环</p>
          <h1>油站库存与配送闭环</h1>
          <p class="subtitle">
            每个油站按油品维护罐容与在库量；新建配送单占用剩余罐容，待发车 → 运输中 → 已到站逐环流转，
            到站吨数自动入库，取消未到站单据释放额度。
          </p>
        </div>
        <div class="stack">
          <span class="tag">Vue3</span>
          <span class="tag">Pinia</span>
          <span class="tag">TypeScript</span>
          <span class="tag">Element Plus</span>
          <button class="secondary reset-btn" type="button" @click="resetDemo">重置演示数据</button>
        </div>
      </header>

      <section class="metrics">
        <article class="metric">
          <span>油罐台账（个）</span>
          <strong>{{ totals.tankCount }}</strong>
        </article>
        <article class="metric">
          <span>总在库（吨）</span>
          <strong>{{ totals.stock.toFixed(1) }}</strong>
        </article>
        <article class="metric">
          <span>占用额度（吨）</span>
          <strong>{{ totals.occupied.toFixed(1) }}</strong>
          <em class="metric-sub">待发车 {{ statusCount("待发车") }} 单 / 运输中 {{ statusCount("运输中") }} 单</em>
        </article>
        <article class="metric">
          <span>剩余可排产（吨）</span>
          <strong :class="{ low: totals.capacity - totals.stock - totals.occupied <= 0 }">
            {{ (totals.capacity - totals.stock - totals.occupied).toFixed(1) }}
          </strong>
        </article>
      </section>

      <!-- 油罐台账：罐容 / 在库 / 占用 / 剩余 -->
      <section class="panel tanks-panel">
        <div class="panel-head">
          <h2>油罐台账（按油站 × 油品）</h2>
          <p class="rule-hint">在库量 = 期初库存 + 已到站累计；占用量 = 待发车 + 运输中计划量；剩余 = 罐容 − 在库 − 占用</p>
        </div>
        <div class="table-wrap">
          <table class="tank-table">
            <thead>
              <tr>
                <th>油站</th>
                <th>油品</th>
                <th class="num">罐容（吨）</th>
                <th class="num">在库量</th>
                <th class="num">占用量</th>
                <th class="num">剩余罐容</th>
                <th>库容使用</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="t in store.tankViews" :key="tankKey(t.station, t.fuel)">
                <td>{{ t.station }}</td>
                <td>{{ t.fuel }}</td>
                <td class="num">
                  <input
                    class="capacity-input"
                    v-model="capacityDrafts[tankKey(t.station, t.fuel)]"
                    type="number"
                    min="0"
                    step="0.1"
                  />
                </td>
                <td class="num stock">{{ t.stock.toFixed(1) }}</td>
                <td class="num" :class="{ occupied: t.occupied > 0 }">{{ t.occupied.toFixed(1) }}</td>
                <td class="num" :class="{ low: t.available <= 0 }">{{ t.available.toFixed(1) }}</td>
                <td>
                  <div class="bar-track">
                    <div
                      class="bar-fill"
                      :class="{ full: t.usageRatio >= 1 }"
                      :style="{ width: `${t.usageRatio * 100}%` }"
                    />
                  </div>
                </td>
                <td>
                  <button class="mini" type="button" @click="saveCapacity(t.station, t.fuel)">保存罐容</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="workspace">
        <!-- 新建配送单 -->
        <form class="panel" @submit.prevent="submit">
          <h2>创建配送单</h2>
          <div class="form-grid">
            <label>
              目标油站
              <select v-model="form.station" required>
                <option value="">请选择</option>
                <option v-for="s in STATIONS" :key="s" :value="s">{{ s }}</option>
              </select>
            </label>
            <label>
              油品
              <select v-model="form.fuel" required>
                <option value="">请选择</option>
                <option v-for="f in FUELS" :key="f" :value="f">{{ f }}</option>
              </select>
            </label>
            <label>
              配送吨数
              <input v-model="form.tons" type="number" min="0" step="0.1" required placeholder="不得超过剩余罐容" />
            </label>
            <p class="capacity-hint" :class="{ danger: overCapacity }">{{ formHint }}</p>
            <p v-if="overCapacity" class="capacity-error">
              本次 {{ tonsNumber }} 吨已超出剩余罐容，无法创建
            </p>
            <label>
              计划到达
              <input v-model="form.arriveAt" type="date" required />
            </label>
            <label>
              备注
              <textarea v-model="form.notes" placeholder="填写处理说明或现场备注" />
            </label>
            <button type="submit" :disabled="overCapacity">保存配送单</button>
          </div>
        </form>

        <!-- 配送单列表 -->
        <section class="list-panel">
          <div class="toolbar">
            <h2>配送单列表</h2>
            <div class="filters">
              <select v-model="stationFilter">
                <option>全部油站</option>
                <option v-for="s in STATIONS" :key="s" :value="s">{{ s }}</option>
              </select>
              <select v-model="statusFilter">
                <option>全部状态</option>
                <option v-for="s in ALL_STATUSES" :key="s" :value="s">{{ s }}</option>
              </select>
            </div>
          </div>

          <div class="record-grid">
            <div v-if="filteredDeliveries.length === 0" class="empty">暂无匹配数据</div>
            <article v-for="d in filteredDeliveries" :key="d.id" class="record" :class="`is-${d.status}`">
              <div class="record-head">
                <p class="record-title">{{ d.station }} / {{ d.fuel }} / {{ d.tons }} 吨</p>
                <span class="status" :class="`st-${d.status}`">{{ d.status }}</span>
              </div>
              <div class="details">
                <span>计划到达：{{ d.arriveAt || "—" }}</span>
                <span>创建时间：{{ eventTime(d, "创建") }}</span>
                <span>发车时间：{{ eventTime(d, "发车") }}</span>
                <span>到站时间：{{ eventTime(d, "到站") }}</span>
              </div>
              <p class="note">{{ d.notes }}</p>
              <div class="actions">
                <button v-if="d.status === '待发车'" type="button" @click="depart(d)">发车 → 运输中</button>
                <button v-if="d.status === '运输中'" type="button" class="arrive" @click="arrive(d)">
                  确认到站 → 入库
                </button>
                <button
                  v-if="d.status === '待发车' || d.status === '运输中'"
                  class="danger"
                  type="button"
                  @click="cancel(d)"
                >
                  取消单据
                </button>
                <span v-if="d.status === '已到站'" class="terminal-hint ok">已入库，记录封存不可回退</span>
                <span v-else-if="d.status === '已取消'" class="terminal-hint">已取消，占用额度已释放</span>
              </div>
            </article>
          </div>

          <div class="mini-chart">
            <div v-for="row in ALL_STATUSES" :key="row" class="bar">
              <span>{{ row }}</span>
              <div class="bar-track">
                <div
                  class="bar-fill"
                  :class="{ muted: row === '已取消' }"
                  :style="{ width: `${(statusCount(row) / Math.max(1, store.deliveries.length)) * 100}%` }"
                />
              </div>
              <strong>{{ statusCount(row) }}</strong>
            </div>
          </div>
          <p class="list-footer">活动单据 {{ activeCount }} 单 ｜ 累计到站 {{ arrivedCount }} 单</p>
        </section>
      </section>
    </div>
  </main>
</template>
