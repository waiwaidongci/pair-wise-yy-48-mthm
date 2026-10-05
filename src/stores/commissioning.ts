import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { useLinkageStore, type Device, type Rule } from './linkage'
import { planRun, type Step, type PreflightIssue, type Receipt } from '../lib/linkageGraph'

// 联调账：矩阵规则 + 动作依赖 + 调试快照接成一次可重放的联调运行

export type RunStatus = 'draft' | 'running' | 'completed' | 'voided'
export type RunEvent = { id: string; at: number; text: string; kind: 'info' | 'success' | 'error' | 'warn' }

export type Run = {
  id: string
  revision: number
  createdAt: number
  startedAt?: number
  finishedAt?: number
  status: RunStatus
  voidReason?: string
  snapshot: { devices: Device[]; rules: Rule[] }
  steps: Step[]
  receipts: Receipt[]
  issues: PreflightIssue[]
  events: RunEvent[]
}

function event(runId: string, kind: RunEvent['kind'], text: string): RunEvent {
  return { id: `EV-${Math.random().toString(36).slice(2, 8)}`, at: Date.now(), text, kind }
}

export const useCommissioningStore = defineStore('commissioning', () => {
  const linkage = useLinkageStore()
  const saved = localStorage.getItem('fire-linkage-runs-v1')
  const runs = ref<Run[]>(saved ? (JSON.parse(saved) as Run[]) : [])

  watch(runs, () => {
    localStorage.setItem('fire-linkage-runs-v1', JSON.stringify(runs.value))
  }, { deep: true })

  // 规则一变：未完成运行作废重排，已完成记录留档
  watch(() => [linkage.rules, linkage.devices], () => {
    for (const run of runs.value) {
      if (run.status === 'draft' || run.status === 'running') {
        run.status = 'voided'
        run.voidReason = '矩阵规则变更，未完成运行作废'
        run.events.push(event(run.id, 'warn', '规则已变更，本次联调作废，请重新编排'))
      }
    }
  }, { deep: true })

  // 版本审阅只能采用最新运行快照
  const latestRun = computed<Run | null>(() => {
    const done = runs.value.filter((r) => r.status === 'completed').sort((a, b) => b.createdAt - a.createdAt)
    return done[0] ?? null
  })

  function createRun(): Run {
    const snapshot = { devices: structuredClone(linkage.devices), rules: structuredClone(linkage.rules) }
    const plan = planRun(snapshot.devices, snapshot.rules)
    const run: Run = {
      id: `RUN-${String(runs.value.length + 1).padStart(3, '0')}`,
      revision: linkage.revision,
      createdAt: Date.now(),
      status: 'draft',
      snapshot,
      steps: plan.steps,
      receipts: [],
      issues: plan.issues,
      events: [],
    }
    run.events.push(event(run.id, 'info', `已按 R${run.revision} 快照编排：${plan.executableCount} 个可执行步骤，隔离 ${plan.isolatedCount} 条不可执行路径`))
    runs.value.push(run)
    return run
  }

  function startRun(runId: string) {
    const run = runs.value.find((r) => r.id === runId)
    if (!run || run.status !== 'draft') return
    run.status = 'running'
    run.startedAt = Date.now()
    // 仅入口步骤（无上游依赖）就绪；级联步骤待上游成功后才就绪
    for (const s of run.steps) {
      if (s.status === 'pending' && executableDeps(run, s).length === 0) s.status = 'ready'
    }
    run.events.push(event(run.id, 'info', '联调开始，按优先级路径推进'))
  }

  function executableDeps(run: Run, step: Step): Step[] {
    return step.depRuleIds
      .map((id) => run.steps.find((s) => s.id === id))
      .filter((s): s is Step => !!s && !s.isolateReason)
  }

  function refreshReady(run: Run) {
    for (const s of run.steps) {
      if (s.status !== 'pending') continue
      const deps = executableDeps(run, s)
      if (deps.length > 0 && deps.every((d) => d.status === 'succeeded')) s.status = 'ready'
    }
  }

  function settle(run: Run) {
    if (run.steps.every((s) => ['succeeded', 'failed', 'skipped', 'isolated'].includes(s.status))) {
      run.status = 'completed'
      run.finishedAt = Date.now()
      run.events.push(event(run.id, 'info', '全部路径已结算，联调记录留档'))
    }
  }

  function executeStep(run: Run, step: Step, failed: boolean) {
    if (step.status !== 'ready' && step.status !== 'running') return
    step.status = failed ? 'failed' : 'succeeded'
    const receipt: Receipt = {
      id: `RCP-${String(run.receipts.length + 1).padStart(3, '0')}`,
      stepId: step.id,
      ruleId: step.ruleId,
      actionId: step.actionId,
      status: failed ? 'failed' : 'succeeded',
      plannedAt: step.plannedAt,
      message: failed ? '现场设备未回执，动作失败' : '设备回执正常',
    }
    step.receipt = receipt
    run.receipts.push(receipt)
    run.events.push(event(run.id, failed ? 'error' : 'success', `${step.ruleId} → ${step.actionId} ${failed ? '失败' : '成功'}${failed ? '，下游依赖暂停' : ''}`))

    if (failed) {
      // 从原回执恢复：只暂停依赖它的节点，已完成动作不重做
      const downstream = transitiveDependents(run, step.id)
      for (const d of run.steps) {
        if (downstream.has(d.id) && (d.status === 'pending' || d.status === 'ready')) {
          d.status = 'skipped'
          d.skipReason = `因上游 ${step.id} 失败暂停，不重做`
          run.events.push(event(run.id, 'warn', `${d.ruleId} 依赖 ${step.id}，暂停执行`))
        }
      }
    } else {
      refreshReady(run)
    }
    settle(run)
  }

  function transitiveDependents(run: Run, stepId: string): Set<string> {
    const result = new Set<string>()
    const queue = [stepId]
    while (queue.length) {
      const cur = queue.shift()!
      for (const s of run.steps) {
        if (!result.has(s.id) && s.depRuleIds.includes(cur)) {
          result.add(s.id)
          queue.push(s.id)
        }
      }
    }
    return result
  }

  function advance(runId: string) {
    const run = runs.value.find((r) => r.id === runId)
    if (!run || run.status !== 'running') return
    const step = run.steps.find((s) => s.status === 'ready')
    if (!step) return
    executeStep(run, step, false)
  }

  function injectFailure(runId: string, stepId: string) {
    const run = runs.value.find((r) => r.id === runId)
    if (!run || run.status !== 'running') return
    const step = run.steps.find((s) => s.id === stepId)
    if (!step || (step.status !== 'ready' && step.status !== 'pending')) return
    executeStep(run, step, true)
  }

  function removeRun(runId: string) {
    const idx = runs.value.findIndex((r) => r.id === runId)
    if (idx >= 0) runs.value.splice(idx, 1)
  }

  return { runs, latestRun, createRun, startRun, advance, injectFailure, removeRun }
})
