<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useCommissioningStore, type Run } from '../stores/commissioning'
import { useLinkageStore } from '../stores/linkage'
import type { Step } from '../lib/linkageGraph'

const store = useCommissioningStore()
const linkage = useLinkageStore()

const selectedRunId = ref<string | null>(null)
const playing = ref(false)
let playTimer: number | undefined

const runs = computed(() => [...store.runs].sort((a, b) => b.createdAt - a.createdAt))
const current = computed<Run | null>(() => store.runs.find((r) => r.id === selectedRunId.value) ?? runs.value[0] ?? null)

const deviceName = (id: string) => linkage.devices.find((d) => d.id === id)?.name ?? id

const stepStatusChip = (step: Step) => {
  switch (step.status) {
    case 'succeeded': return { color: 'success', text: '已完成' }
    case 'failed': return { color: 'error', text: '失败' }
    case 'skipped': return { color: 'warning', text: '已暂停' }
    case 'isolated': return { color: 'default', text: '已隔离' }
    case 'running': return { color: 'primary', text: '执行中' }
    case 'ready': return { color: 'info', text: '待执行' }
    default: return { color: 'default', text: '排队中' }
  }
}

const isolateText: Record<string, string> = {
  cycle: '联动环',
  'missing-device': '缺失设备',
  'upstream-isolated': '上游不可执行',
  'duplicate-action': '重复动作',
}

const progress = computed(() => {
  const run = current.value
  if (!run) return { done: 0, total: 0, pct: 0 }
  const executable = run.steps.filter((s) => !s.isolateReason)
  const done = executable.filter((s) => ['succeeded', 'failed', 'skipped'].includes(s.status)).length
  return { done, total: executable.length, pct: executable.length ? Math.round((done / executable.length) * 100) : 0 }
})

const issueIcon = (type: string) => (type === 'cycle' ? 'mdi-autorenew' : type === 'missing-device' ? 'mdi-help-circle-outline' : 'mdi-content-copy')

function createRun() {
  const run = store.createRun()
  selectedRunId.value = run.id
}

function startRun() {
  if (current.value) store.startRun(current.value.id)
}

function advance() {
  if (current.value) store.advance(current.value.id)
}

function togglePlay() {
  playing.value = !playing.value
}

function injectFailure(step: Step) {
  if (current.value) store.injectFailure(current.value.id, step.id)
}

function removeRun(id: string) {
  store.removeRun(id)
  if (selectedRunId.value === id) selectedRunId.value = null
}

watch(playing, (v) => {
  if (playTimer) window.clearInterval(playTimer)
  if (v) {
    playTimer = window.setInterval(() => {
      const run = current.value
      if (!run || run.status !== 'running') {
        playing.value = false
        return
      }
      const next = run.steps.find((s) => s.status === 'ready')
      if (!next) {
        playing.value = false
        return
      }
      store.advance(run.id)
    }, 850)
  }
})

watch(() => current.value?.status, (status) => {
  if (status !== 'running') playing.value = false
})
</script>

<template>
  <section class="page">
    <div class="page-head">
      <div>
        <p class="eyebrow">COMMISSIONING LEDGER / 联调账</p>
        <h1>矩阵规则联调回放</h1>
        <p class="muted">开跑前先查环、缺失设备与重复动作；失败后从原回执恢复，只暂停依赖节点，已完成动作不重做。</p>
      </div>
      <div class="actions">
        <v-btn variant="outlined" prepend-icon="mdi-plus" @click="createRun">编排新运行</v-btn>
        <v-btn v-if="current?.status === 'draft'" color="primary" prepend-icon="mdi-play" @click="startRun">开始联调</v-btn>
      </div>
    </div>

    <v-alert v-if="!runs.length" type="info" variant="tonal" class="mb-4">
      尚未编排联调运行。点击「编排新运行」，系统将按当前矩阵快照检查联动环、缺失设备与重复动作，隔离不可执行路径后按优先级推进。
    </v-alert>

    <div v-if="current" class="ledger">
      <div class="run-list panel">
        <div class="panel-head"><h3>联调账</h3><v-chip size="small" variant="tonal">{{ runs.length }} 次</v-chip></div>
        <div class="run-items">
          <button v-for="run in runs" :key="run.id" class="run-item" :class="{ active: run.id === current.id }" @click="selectedRunId = run.id">
            <div class="run-item-top">
              <strong>{{ run.id }}</strong>
              <v-chip size="x-small" :color="run.status === 'completed' ? 'success' : run.status === 'voided' ? 'warning' : run.status === 'running' ? 'primary' : 'default'" variant="tonal">
                {{ run.status === 'completed' ? '已留档' : run.status === 'voided' ? '已作废' : run.status === 'running' ? '联调中' : '待开始' }}
              </v-chip>
            </div>
            <small>R{{ run.revision }} · {{ new Date(run.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) }}</small>
          </button>
        </div>
      </div>

      <div class="run-detail">
        <div class="panel run-head">
          <div class="run-head-main">
            <div class="run-title">
              <h2>{{ current.id }}</h2>
              <v-chip size="small" variant="tonal" prepend-icon="mdi-file-document-outline">采用 R{{ current.revision }} 快照</v-chip>
              <v-chip v-if="current.status === 'voided'" size="small" color="warning" variant="tonal" prepend-icon="mdi-alert-outline">{{ current.voidReason }}</v-chip>
            </div>
            <div class="run-progress">
              <v-progress-linear :model-value="progress.pct" color="primary" height="8" rounded />
              <span>{{ progress.done }}/{{ progress.total }} 路径已结算</span>
            </div>
          </div>
          <div class="run-controls">
            <template v-if="current.status === 'draft'">
              <v-btn color="primary" prepend-icon="mdi-play" @click="startRun">开始联调</v-btn>
            </template>
            <template v-else-if="current.status === 'running'">
              <v-btn variant="outlined" prepend-icon="mdi-step-forward" @click="advance">推进一步</v-btn>
              <v-btn :color="playing ? 'warning' : 'primary'" :prepend-icon="playing ? 'mdi-pause' : 'mdi-play'" @click="togglePlay">{{ playing ? '暂停' : '自动播放' }}</v-btn>
            </template>
            <v-btn variant="text" color="error" prepend-icon="mdi-delete-outline" @click="removeRun(current.id)">删除</v-btn>
          </div>
        </div>

        <div class="panel">
          <div class="panel-head"><h3>前置检查</h3><v-chip size="small" :color="current.issues.some((i) => i.severity === '错误') ? 'error' : 'success'" variant="tonal">{{ current.issues.length ? `${current.issues.length} 项` : '通过' }}</v-chip></div>
          <div class="issue-list">
            <div v-for="issue in current.issues" :key="issue.title" class="issue" :class="issue.severity">
              <v-icon :icon="issueIcon(issue.type)" />
              <div>
                <strong>{{ issue.title }}</strong>
                <p>{{ issue.detail }}</p>
                <small>建议：{{ issue.suggestion }}</small>
              </div>
            </div>
            <div v-if="!current.issues.length" class="issue-empty"><v-icon icon="mdi-check-decagram" color="success" /><span>未发现联动环、缺失设备或重复动作，全部路径可推进。</span></div>
          </div>
        </div>

        <div class="panel">
          <div class="panel-head"><h3>执行步骤</h3><span class="muted">按优先级路径排序 · 失败后仅暂停下游依赖</span></div>
          <div class="step-table">
            <div class="step-row step-head">
              <span>时刻</span><span>规则</span><span>触发 → 动作</span><span>优先级</span><span>状态</span><span>回执 / 说明</span><span>操作</span>
            </div>
            <div v-for="step in current.steps" :key="step.id" class="step-row" :class="{ isolated: step.isolateReason, failed: step.status === 'failed', skipped: step.status === 'skipped' }">
              <span class="mono">{{ step.isolateReason ? '—' : `${step.plannedAt}s` }}</span>
              <span class="mono"><strong>{{ step.ruleId }}</strong></span>
              <span class="step-path">{{ deviceName(step.triggerId) }} → {{ deviceName(step.actionId) }}</span>
              <span><v-chip size="x-small" :color="step.priority === 1 ? 'error' : step.priority === 2 ? 'warning' : 'default'" variant="tonal">P{{ step.priority }}</v-chip></span>
              <span><v-chip size="x-small" :color="stepStatusChip(step).color" variant="tonal">{{ stepStatusChip(step).text }}</v-chip></span>
              <span class="step-receipt">
                <template v-if="step.isolateReason"><span class="isolate-tag">{{ isolateText[step.isolateReason] }}</span></template>
                <template v-else-if="step.receipt">
                  <span :class="step.receipt.status === 'failed' ? 'receipt-fail' : 'receipt-ok'">{{ step.receipt.id }} · {{ step.receipt.message }}</span>
                </template>
                <template v-else-if="step.skipReason"><span class="skip-reason">{{ step.skipReason }}</span></template>
                <template v-else><span class="muted">—</span></template>
              </span>
              <span>
                <v-btn v-if="current.status === 'running' && (step.status === 'ready' || step.status === 'pending')" size="x-small" color="error" variant="tonal" @click="injectFailure(step)">标记失败</v-btn>
                <span v-else class="muted">—</span>
              </span>
            </div>
          </div>
        </div>

        <div class="panel">
          <div class="panel-head"><h3>联调事件</h3><span class="muted">可重放的操作留痕</span></div>
          <div class="event-list">
            <div v-for="ev in [...current.events].reverse()" :key="ev.id" class="event" :class="ev.kind">
              <span class="event-time">{{ new Date(ev.at).toLocaleTimeString('zh-CN', { hour12: false }) }}</span>
              <span>{{ ev.text }}</span>
            </div>
            <div v-if="!current.events.length" class="muted">暂无事件。</div>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.actions { display: flex; gap: 8px; }
.ledger { display: grid; grid-template-columns: 280px minmax(0, 1fr); gap: 14px; align-items: start; }
.run-list { position: sticky; top: 14px; }
.run-items { display: grid; gap: 8px; padding: 12px; max-height: 560px; overflow-y: auto; }
.run-item { display: grid; gap: 4px; padding: 10px 12px; border: 1px solid #e2e8e8; border-radius: 8px; background: white; text-align: left; cursor: pointer; }
.run-item.active { border-color: #a64c35; background: #fdf3f1; }
.run-item-top { display: flex; align-items: center; justify-content: space-between; }
.run-item small { color: #7b878c; }
.run-detail { display: grid; gap: 14px; }
.run-head { padding: 16px; }
.run-head-main { display: grid; gap: 12px; }
.run-title { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.run-title h2 { margin: 0; font-size: 20px; }
.run-progress { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 12px; }
.run-progress span { color: #6f7b80; font-size: 12px; }
.run-controls { display: flex; gap: 8px; margin-top: 14px; flex-wrap: wrap; }
.issue-list { padding: 8px 16px 16px; }
.issue { display: grid; grid-template-columns: 28px 1fr; gap: 10px; padding: 12px 0; border-bottom: 1px solid #edf0f0; }
.issue.error { color: #b13d2c; }
.issue.warning { color: #b87b22; }
.issue strong { font-size: 13px; }
.issue p { margin: 5px 0; color: #59676d; font-size: 12px; line-height: 1.5; }
.issue small { color: #7f8b90; }
.issue-empty { display: flex; align-items: center; gap: 8px; padding: 24px; color: #3d7b63; font-size: 13px; }
.step-table { padding: 8px 12px 14px; overflow-x: auto; }
.step-row { display: grid; grid-template-columns: 56px 70px minmax(220px, 1.4fr) 64px 78px minmax(200px, 1.2fr) 80px; align-items: center; gap: 10px; padding: 9px 6px; border-bottom: 1px solid #eef1f1; font-size: 12px; }
.step-row.step-head { color: #7b878c; font-size: 11px; font-weight: 700; border-bottom: 1px solid #dde3e3; }
.step-row.isolated { opacity: 0.62; }
.step-row.failed { background: #fdf0ee; }
.step-row.skipped { background: #fdf8ee; }
.step-path { color: #3a4a50; }
.mono { font-family: ui-monospace, monospace; }
.isolate-tag { color: #8a6d3b; }
.receipt-ok { color: #2e755e; }
.receipt-fail { color: #b23e2a; }
.skip-reason { color: #b87928; }
.event-list { padding: 8px 16px 16px; display: grid; gap: 8px; }
.event { display: flex; gap: 10px; align-items: baseline; font-size: 12px; color: #49585e; }
.event-time { color: #9aa6ab; font-family: ui-monospace, monospace; font-size: 11px; }
.event.success { color: #2e755e; }
.event.error { color: #b23e2a; }
.event.warn { color: #b87928; }
@media (max-width: 1000px) { .ledger { grid-template-columns: 1fr; } }
</style>
