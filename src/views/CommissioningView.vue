<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { useLinkageStore } from '../stores/linkage'
import { buildCommissioningGraph, type ActionReceipt, type CommissionRun, type GraphEdge, type LedgerEvent, type PathCandidate, type ReceiptStatus } from '../linkage/commissioning'

const store = useLinkageStore()
const selectedRootIds = ref<string[]>([])
const failDeviceId = ref<string>('')
const replayAt = ref<number | null>(null)
let replayTimer: number | undefined

const liveGraph = computed(() => store.commissionGraph)
const latestRun = computed(() => store.latestRun)
const isLatestCurrent = computed(() => Boolean(latestRun.value && latestRun.value.configHash === liveGraph.value.configHash))
const runGraph = computed(() => latestRun.value ? buildCommissioningGraph(latestRun.value.devices, latestRun.value.rules) : liveGraph.value)

watch(liveGraph, (graph) => {
  const current = selectedRootIds.value.filter((id) => graph.defaultRootIds.includes(id))
  selectedRootIds.value = current.length ? current : [...graph.defaultRootIds]
}, { immediate: true })

const rootDevices = computed(() => liveGraph.value.defaultRootIds.map((id) => liveGraph.value.nodeMap.get(id)!.device))
const actionOptions = computed(() => liveGraph.value.nodes
  .filter((node) => node.kind !== 'trigger' && !node.quarantined && layersReachable(node.id))
  .map((node) => ({ title: node.device.name, value: node.id })))

function layersReachable(nodeId: string) {
  return (liveGraph.value.pathsByTarget.get(nodeId) ?? []).some((path) => selectedRootIds.value.includes(path.rootId))
}

const selectedPathGroups = computed(() => {
  const roots = new Set(selectedRootIds.value)
  const groups: { target: string; paths: PathCandidate[] }[] = []
  liveGraph.value.pathsByTarget.forEach((paths, target) => {
    const selected = paths.filter((path) => roots.has(path.rootId))
    if (selected.length) groups.push({ target, paths: selected })
  })
  return groups
})

const arbitrationRows = computed(() => selectedPathGroups.value
  .filter((group) => group.paths.length > 1)
  .map((group) => ({
    target: group.target,
    best: group.paths[0],
    alternatives: group.paths.slice(1),
  })))

const preflightIssues = computed(() => latestRun.value ? latestRun.value.issues : liveGraph.value.issues)
const errorCount = computed(() => preflightIssues.value.filter((issue) => issue.severity === '错误').length)
const warningCount = computed(() => preflightIssues.value.filter((issue) => issue.severity === '警告').length)
const executableEdges = computed(() => [...liveGraph.value.edges].filter((edge) => edge.state === 'executable'))
const reachableTargetCount = computed(() => selectedPathGroups.value.length)

const replayEvents = computed(() => {
  if (!latestRun.value) return []
  const at = replayAt.value
  if (at === null) return latestRun.value.events
  return latestRun.value.events.filter((event) => event.atSecond <= at)
})
const replayMax = computed(() => Math.max(0, ...(latestRun.value?.events.map((event) => event.atSecond) ?? [0])))
const replayProgress = computed(() => replayAt.value === null ? 100 : replayMax.value === 0 ? 100 : Math.round((replayAt.value / replayMax.value) * 100))

watch(() => latestRun.value?.id, () => {
  stopReplay()
})

onUnmounted(stopReplay)

function stopReplay() {
  if (replayTimer !== undefined) window.clearInterval(replayTimer)
  replayTimer = undefined
  replayAt.value = null
}

function toggleReplay() {
  if (!latestRun.value) return
  if (replayTimer !== undefined) {
    stopReplay()
    return
  }
  replayAt.value = 0
  const max = replayMax.value
  replayTimer = window.setInterval(() => {
    const current = replayAt.value
    if (current === null || current >= max) {
      stopReplay()
      return
    }
    replayAt.value = Math.min(max, current + 1)
  }, 700)
}

function start() {
  stopReplay()
  store.startRun(selectedRootIds.value, failDeviceId.value || undefined)
  failDeviceId.value = ''
}

function resume() {
  stopReplay()
  store.resumeLatestRun()
}

function rerun() {
  stopReplay()
  store.rerunLatest()
}

function deviceName(id: string, graph = liveGraph.value) {
  return graph.nodeMap.get(id)?.device.name ?? id
}

function edgeText(edge: GraphEdge, graph = liveGraph.value) {
  const rule = graph.edgeMap.get(edge.id)
  return `${edge.ruleId} · P${rule?.priority ?? edge.priority} · +${edge.delay}s`
}

function pathText(path: PathCandidate) {
  const graph = runGraph.value
  return path.nodeIds.map((id) => deviceName(id, graph)).join(' → ')
}

function edgeIdsText(edgeIds: string[]) {
  if (!latestRun.value) return '—'
  return edgeIds.map((id) => runGraph.value.edgeMap.get(id)?.ruleId ?? id).join(' → ')
}

function statusLabel(status: ReceiptStatus) {
  return {
    trigger: '报警源',
    completed: '完成',
    failed: '失败',
    paused: '已暂停',
    quarantined: '成环隔离',
    isolated: '路径隔离',
  }[status]
}

function statusColor(status: ReceiptStatus) {
  return {
    trigger: 'secondary',
    completed: 'success',
    failed: 'error',
    paused: 'warning',
    quarantined: 'error',
    isolated: 'warning',
  }[status]
}

function runStatusLabel(run: CommissionRun) {
  if (run.status === 'completed') return '可执行路径已跑完'
  if (run.status === 'paused') return '失败点下游暂停'
  return '规则已变，未完成运行作废'
}

function eventColor(event: LedgerEvent) {
  return statusColor(event.type as ReceiptStatus)
}

const isolatedEvents = computed(() => latestRun.value?.events.filter((event) => event.type === 'isolate') ?? [])
const completedCount = computed(() => latestRun.value?.receipts.filter((receipt) => receipt.status === 'completed').length ?? 0)
const failedCount = computed(() => latestRun.value?.receipts.filter((receipt) => receipt.status === 'failed' || receipt.status === 'paused').length ?? 0)
const archivedRuns = computed(() => [...store.commissioningRuns].reverse().slice(0, 8))
</script>

<template>
  <section class="page">
    <div class="page-head">
      <div>
        <p class="eyebrow">REPLAYABLE LEDGER / 可重放联调账</p>
        <h1>预检、排程、回执与恢复</h1>
        <p class="muted">不可执行路径开始前隔离，其余路径照常推进；失败后按原回执恢复，只暂停依赖失败动作的下游节点。</p>
      </div>
      <div class="actions">
        <v-btn variant="outlined" prepend-icon="mdi-graph-outline" @click="$router.push('/dependency')">查看依赖图</v-btn>
        <v-btn color="primary" prepend-icon="mdi-play-outline" :disabled="!selectedRootIds.length" @click="start">开始联调</v-btn>
      </div>
    </div>

    <div class="metric-grid">
      <article><span>预检错误</span><strong class="error">{{ errorCount }}</strong><small>成环 / 缺失设备，隔离不阻断其他路径</small></article>
      <article><span>预检警告</span><strong class="warning">{{ warningCount }}</strong><small>重复动作按高优先级保留主路径</small></article>
      <article><span>本次动作点</span><strong>{{ reachableTargetCount }}</strong><small>{{ executableEdges.length }} 条可执行边参与排程</small></article>
      <article><span>最新运行</span><strong>{{ completedCount }}/{{ failedCount ? `${completedCount}+${failedCount}` : completedCount }}</strong><small>{{ latestRun ? runStatusLabel(latestRun) : '尚未生成快照' }}</small></article>
    </div>

    <div class="ledger-grid">
      <div class="main-column">
        <section class="panel mb-3">
          <div class="panel-head">
            <h3>1. 开始前检查与报警源</h3>
            <v-chip size="small" variant="tonal" :color="isLatestCurrent ? 'success' : 'warning'">R{{ store.revision }} · {{ liveGraph.configHash.slice(0, 8) }}</v-chip>
          </div>
          <div class="setup-grid">
            <div class="root-list">
              <div v-for="device in rootDevices" :key="device.id" class="root-item">
                <v-checkbox-btn :model-value="selectedRootIds.includes(device.id)" @update:model-value="(value) => selectedRootIds = value ? [...selectedRootIds, device.id] : selectedRootIds.filter((id) => id !== device.id)" />
                <div><strong>{{ device.name }}</strong><small>{{ device.id }} · {{ device.floor }} / {{ device.zone }}</small></div>
              </div>
            </div>
            <div class="failure-box">
              <v-select v-model="failDeviceId" :items="actionOptions" label="模拟执行失败动作（可选）" clearable density="compact" />
              <div class="run-actions">
                <v-btn color="primary" prepend-icon="mdi-play" :disabled="!selectedRootIds.length" @click="start">重排并开始</v-btn>
                <v-btn color="success" variant="tonal" prepend-icon="mdi-restore" :disabled="!latestRun || latestRun.status !== 'paused' || !isLatestCurrent" @click="resume">从原回执恢复</v-btn>
                <v-btn variant="tonal" prepend-icon="mdi-refresh" :disabled="!latestRun" @click="rerun">按新规则重跑</v-btn>
                <v-btn variant="outlined" prepend-icon="mdi-replay" :disabled="!latestRun" @click="toggleReplay">{{ replayAt === null ? '播放快照' : '停止播放' }}</v-btn>
              </div>
              <v-alert v-if="latestRun && !isLatestCurrent" type="warning" variant="tonal" density="compact">规则版本已改变：旧运行中未完成部分已作废并保留原完成记录；请按新规则重排。</v-alert>
            </div>
          </div>
        </section>

        <section class="panel mb-3">
          <div class="panel-head"><h3>2. 同一动作的高优先级路径裁决</h3><span class="muted">等级取路径中最低优先级，同级比累计延时</span></div>
          <v-table density="compact">
            <thead><tr><th>动作</th><th>首选路径</th><th>等级 / 延时</th><th>备选</th></tr></thead>
            <tbody>
              <tr v-for="row in arbitrationRows" :key="row.target">
                <td><strong>{{ deviceName(row.target) }}</strong></td>
                <td>{{ pathText(row.best) }}</td>
                <td><v-chip size="small" color="secondary" variant="tonal">P{{ row.best.rank }} · {{ row.best.totalDelay }}s</v-chip></td>
                <td>{{ row.alternatives.length }} 条；首选上游失败时自动使用下一条可走路径</td>
              </tr>
              <tr v-if="!arbitrationRows.length"><td colspan="4" class="muted">当前报警源下没有需要裁决的重复到达路径。</td></tr>
            </tbody>
          </v-table>
        </section>

        <section class="panel mb-3">
          <div class="panel-head">
            <h3>3. 动作回执</h3>
            <span v-if="latestRun" class="muted">{{ latestRun.id }} · 完成动作不重做</span>
          </div>
          <v-table v-if="latestRun" density="compact">
            <thead><tr><th>时刻</th><th>动作</th><th>状态</th><th>执行路径</th><th>恢复信息</th></tr></thead>
            <tbody>
              <tr v-for="receipt in latestRun.receipts" :key="receipt.id" :class="receipt.status">
                <td class="mono">{{ receipt.attempts[0]?.atSecond ?? 0 }}s</td>
                <td><strong>{{ deviceName(receipt.deviceId, runGraph) }}</strong><small v-if="receipt.terminalRuleId"> · {{ receipt.terminalRuleId }}</small></td>
                <td><v-chip size="small" :color="statusColor(receipt.status)" variant="tonal">{{ statusLabel(receipt.status) }}</v-chip></td>
                <td>{{ edgeIdsText(receipt.pathEdgeIds) || '—' }}</td>
                <td>
                  <span v-if="receipt.recovered" class="recovered">已恢复，保留原失败回执</span>
                  <span v-else-if="receipt.reason">{{ receipt.reason }}</span>
                  <span v-else-if="receipt.blockedBy">等待 {{ deviceName(receipt.blockedBy, runGraph) }}</span>
                  <span v-else>—</span>
                </td>
              </tr>
            </tbody>
          </v-table>
          <div v-else class="empty-state"><v-icon icon="mdi-script-text-outline" size="36" /><strong>还没有联调快照</strong><span>选择报警源后开始，系统会先隔离成环、缺失和重复路径。</span></div>
        </section>

        <section class="panel">
          <div class="panel-head"><h3>4. 调试快照时间线</h3><v-progress-linear v-if="replayAt !== null" :model-value="replayProgress" color="secondary" height="6" style="width:160px" /></div>
          <div class="event-list">
            <article v-for="event in replayEvents" :key="`${event.seq}-${event.type}`">
              <span class="event-time">T{{ event.atSecond }}s</span>
              <v-chip size="x-small" :color="eventColor(event)" variant="tonal">{{ statusLabel(event.type as ReceiptStatus) }}</v-chip>
              <p>{{ event.message }}</p>
            </article>
            <div v-if="!replayEvents.length" class="empty-state compact">开始联调后，可逐秒重放所有触发、隔离、完成、失败与恢复事件。</div>
          </div>
        </section>
      </div>

      <aside class="side-column">
        <section class="panel mb-3">
          <div class="panel-head"><h3>开始前检查</h3><v-chip size="small" :color="errorCount ? 'error' : 'success'" variant="tonal">{{ preflightIssues.length }}</v-chip></div>
          <div class="issue-list">
            <article v-for="issue in preflightIssues" :key="issue.id" :class="issue.severity">
              <strong>{{ issue.title }}</strong>
              <p>{{ issue.detail }}</p>
              <small>{{ issue.suggestion }}</small>
            </article>
            <v-alert v-if="!preflightIssues.length" type="success" variant="tonal" density="compact">无环、无缺失设备、无重复动作，所有路径可进入排程。</v-alert>
          </div>
        </section>

        <section class="panel mb-3">
          <div class="panel-head"><h3>已隔离路径</h3><span class="muted">{{ isolatedEvents.length }} 条事件</span></div>
          <div class="isolated-list">
            <div v-for="event in isolatedEvents" :key="event.seq"><v-icon size="15" color="warning">mdi-shield-off-outline</v-icon><span>{{ event.message }}</span></div>
            <div v-if="!isolatedEvents.length" class="muted">本次运行没有隔离路径。</div>
          </div>
        </section>

        <section class="panel">
          <div class="panel-head"><h3>运行留档</h3><span class="muted">只审阅最新当前快照</span></div>
          <div class="archive-list">
            <div v-for="run in archivedRuns" :key="run.id" class="archive-item" :class="{ active: latestRun?.id === run.id }" :title="run.id">
              <b>{{ run.id }}</b>
              <span>{{ run.status === 'superseded' ? '已作废重排' : runStatusLabel(run) }}</span>
              <small>R{{ run.revision }} · {{ run.receipts.length }} 张回执</small>
            </div>
          </div>
        </section>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
.metric-grid { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 12px; margin-bottom: 14px; }
.metric-grid article { padding: 16px; border: 1px solid #dde3e3; border-radius: 10px; background: white; }
.metric-grid span, .metric-grid small { display: block; color: #758187; font-size: 12px; }
.metric-grid strong { display: block; margin: 7px 0; color: #293e45; font-size: 26px; }
.metric-grid .error { color: #b23e2a; }
.metric-grid .warning { color: #bd7928; }
.ledger-grid { display: grid; grid-template-columns: minmax(0,1fr) 360px; gap: 14px; align-items: start; }
.setup-grid { display: grid; grid-template-columns: minmax(0,1fr) 330px; gap: 16px; padding: 16px; }
.root-list { display: grid; gap: 7px; }
.root-item { display: flex; align-items: center; gap: 8px; padding: 8px; border: 1px solid #e8ecec; border-radius: 8px; }
.root-item strong, .root-item small { display: block; }
.root-item small { color: #7b878c; margin-top: 3px; }
.failure-box { display: grid; gap: 10px; align-content: start; }
.run-actions { display: flex; gap: 7px; flex-wrap: wrap; }
.mono { color: #267078; font-family: ui-monospace,monospace; font-weight: 700; }
.empty-state { display: grid; justify-items: center; gap: 7px; padding: 42px; color: #6a777d; }
.empty-state.compact { padding: 24px; font-size: 12px; }
.event-list { max-height: 360px; overflow: auto; padding: 12px 16px 16px; }
.event-list article { display: grid; grid-template-columns: 48px 76px 1fr; gap: 9px; align-items: start; padding: 9px 0; border-bottom: 1px solid #edf0f0; }
.event-time { color: #267078; font-family: ui-monospace,monospace; font-size: 11px; font-weight: 800; padding-top: 3px; }
.event-list p { margin: 0; color: #4f5e64; font-size: 12px; line-height: 1.45; }
.issue-list { display: grid; gap: 10px; padding: 14px; }
.issue-list article { padding: 10px; border-left: 3px solid #bd6f2a; background: #fff8ef; border-radius: 4px; }
.issue-list article.错误 { border-color: #b23e2a; background: #fff4f1; }
.issue-list strong { font-size: 12px; color: #2f4148; }
.issue-list p { margin: 6px 0; color: #5d6b71; font-size: 11px; line-height: 1.45; }
.issue-list small { color: #829096; font-size: 10px; }
.isolated-list { display: grid; gap: 9px; padding: 14px; font-size: 11px; color: #5e6d73; }
.isolated-list div { display: flex; gap: 7px; align-items: flex-start; }
.archive-list { display: grid; gap: 8px; padding: 14px; }
.archive-item { padding: 10px; border: 1px solid #e2e7e8; border-radius: 8px; background: #fafbfb; text-align: left; }
.archive-item.active { border-color: #265e66; background: #edf6f7; }
.archive-item b, .archive-item span, .archive-item small { display: block; }
.archive-item b { font-size: 11px; color: #263c43; }
.archive-item span { margin: 4px 0; font-size: 11px; color: #5e6d73; }
.archive-item small { color: #8b979c; }
tr.failed td, tr.paused td { background: #fff7f0; }
tr.completed td { background: #fbfffd; }
.recovered { color: #2e755e; font-weight: 700; }
@media (max-width: 1150px) { .ledger-grid, .setup-grid { grid-template-columns: 1fr; } .metric-grid { grid-template-columns: 1fr 1fr; } }
</style>
