import type { Device, Rule, Validation } from '../stores/linkage'

// 联调账核心图算法：环检测、缺失设备、重复动作、运行计划编排

export type IssueType = 'cycle' | 'missing-device' | 'duplicate-action'
export type IsolateReason = 'missing-device' | 'cycle' | 'upstream-isolated' | 'duplicate-action'
export type StepStatus = 'pending' | 'ready' | 'running' | 'succeeded' | 'failed' | 'isolated' | 'skipped'

export type PreflightIssue = {
  type: IssueType
  severity: '错误' | '警告'
  ruleIds: string[]
  title: string
  detail: string
  suggestion: string
}

export type Receipt = {
  id: string
  stepId: string
  ruleId: string
  actionId: string
  status: 'succeeded' | 'failed'
  plannedAt: number
  message: string
}

export type Step = {
  id: string
  ruleId: string
  triggerId: string
  actionId: string
  delay: number
  priority: 1 | 2 | 3
  interlock: string
  suppression: string
  status: StepStatus
  isolateReason?: IsolateReason
  depRuleIds: string[]
  plannedAt: number
  receipt?: Receipt
  skipReason?: string
}

export type RunPlan = {
  steps: Step[]
  issues: PreflightIssue[]
  executableCount: number
  isolatedCount: number
}

// Tarjan 强连通分量，用于发现联动环
export function tarjan(ids: string[], outgoing: (id: string) => string[]): string[][] {
  let index = 0
  const indices = new Map<string, number>()
  const low = new Map<string, number>()
  const stack: string[] = []
  const onStack = new Set<string>()
  const sccs: string[][] = []

  function strong(v: string) {
    indices.set(v, index)
    low.set(v, index)
    index++
    stack.push(v)
    onStack.add(v)
    for (const w of outgoing(v)) {
      if (!indices.has(w)) {
        strong(w)
        low.set(v, Math.min(low.get(v)!, low.get(w)!))
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, indices.get(w)!))
      }
    }
    if (low.get(v) === indices.get(v)) {
      const scc: string[] = []
      let w: string
      do {
        w = stack.pop()!
        onStack.delete(w)
        scc.push(w)
      } while (w !== v)
      sccs.push(scc)
    }
  }

  for (const id of ids) if (!indices.has(id)) strong(id)
  return sccs
}

// 级联边：规则 r 依赖所有「动作设备 == r 的触发设备」的上游规则
export function cascadeDepsOf(rules: Rule[], r: Rule): string[] {
  return rules.filter((x) => x.actionId === r.triggerId).map((x) => x.id)
}

export function detectCycleSccs(rules: Rule[]): string[][] {
  const ids = rules.map((r) => r.id)
  return tarjan(ids, (id) => {
    const r = rules.find((x) => x.id === id)!
    return cascadeDepsOf(rules, r)
  }).filter((scc) => {
    if (scc.length > 1) return true
    const r = rules.find((x) => x.id === scc[0])
    return !!r && r.triggerId === r.actionId
  })
}

// 矩阵校验：在原有校验基础上补充环检测与缺失设备引用
export function computeValidations(devices: Device[], rules: Rule[]): Validation[] {
  const result: Validation[] = []
  const deviceIds = new Set(devices.map((d) => d.id))
  const triggers = devices.filter((d) => ['感烟探测器', '感温探测器', '手动报警按钮', '输入模块'].includes(d.type))

  for (const trigger of triggers) {
    const enabled = rules.filter((rule) => rule.triggerId === trigger.id && rule.enabled)
    if (enabled.length === 0) {
      result.push({ id: `missing-${trigger.id}`, severity: '错误', ruleIds: [], title: `${trigger.name} 缺少联动动作`, detail: '报警点未配置任何启用的因果规则。', suggestion: '至少配置广播、排烟或疏散相关动作。' })
    }
  }

  for (const rule of rules.filter((r) => r.enabled)) {
    const missing: string[] = []
    if (!deviceIds.has(rule.triggerId)) missing.push(rule.triggerId)
    if (!deviceIds.has(rule.actionId)) missing.push(rule.actionId)
    if (missing.length) {
      result.push({ id: `missing-device-${rule.id}`, severity: '错误', ruleIds: [rule.id], title: `${rule.id} 引用缺失设备`, detail: `规则引用了台账中不存在的设备（${missing.join('、')}），动作无法下发。`, suggestion: '在设备台账中补全点位，或在矩阵中修正触发/动作引用。' })
    }
  }

  const validRules = rules.filter((r) => r.enabled && deviceIds.has(r.triggerId) && deviceIds.has(r.actionId))
  detectCycleSccs(validRules).forEach((scc, i) => {
    const ruleIds = validRules.filter((r) => scc.includes(r.triggerId) && scc.includes(r.actionId)).map((r) => r.id)
    result.push({ id: `cycle-${i}`, severity: '错误', ruleIds, title: `检测到 ${scc.length} 个设备参与的联动环`, detail: `${ruleIds.join('、')} 首尾相接构成闭环，动作会反复触发、无法自行终止。`, suggestion: '断开环路上的一条反馈规则，或改为单次触发。' })
  })

  for (const rule of rules.filter((r) => r.enabled)) {
    const trigger = devices.find((device) => device.id === rule.triggerId)
    const action = devices.find((device) => device.id === rule.actionId)
    if (trigger && action && trigger.zone !== action.zone && rule.suppression === '无') {
      result.push({ id: `cross-${rule.id}`, severity: '警告', ruleIds: [rule.id], title: `${rule.id} 跨区联动未配置抑制`, detail: `${trigger.zone} 报警将直接触发 ${action.zone} 动作。`, suggestion: '确认疏散边界并增加分区确认或抑制条件。' })
    }
    if (rule.interlock && rule.delay > 5 && rule.priority === 1) {
      result.push({ id: `contradiction-${rule.id}`, severity: '错误', ruleIds: [rule.id], title: `${rule.id} 互锁与高优先级延时冲突`, detail: '一级优先规则在互锁未明确反馈前延时超过 5 秒。', suggestion: '缩短延时或改为反馈后触发。' })
    }
  }

  // 同一动作被多条规则触发：按优先级保留唯一执行路径，其余在联调中隔离
  const byAction = new Map<string, Rule[]>()
  for (const rule of validRules) {
    const list = byAction.get(rule.actionId) ?? []
    list.push(rule)
    byAction.set(rule.actionId, list)
  }
  for (const [actionId, list] of byAction) {
    if (list.length > 1) {
      const rep = [...list].sort((a, b) => a.priority - b.priority || a.delay - b.delay || a.id.localeCompare(b.id))[0]
      result.push({ id: `duplicate-${actionId}`, severity: '警告', ruleIds: list.map((r) => r.id), title: `同一动作 ${actionId} 被 ${list.length} 条规则触发`, detail: `联调时将按优先级由 ${rep.id} 执行，其余路径隔离。`, suggestion: '确认主备关系，或合并为单条规则。' })
    }
  }

  return result
}

// 联调运行计划：前置检查 + 路径隔离 + 优先级编排
export function planRun(devices: Device[], rules: Rule[]): RunPlan {
  const deviceIds = new Set(devices.map((d) => d.id))
  const enabled = rules.filter((r) => r.enabled)
  const issues: PreflightIssue[] = []
  const isolated = new Map<string, IsolateReason>()

  // 1) 缺失设备
  for (const r of enabled) {
    const missing: string[] = []
    if (!deviceIds.has(r.triggerId)) missing.push(r.triggerId)
    if (!deviceIds.has(r.actionId)) missing.push(r.actionId)
    if (missing.length) {
      isolated.set(r.id, 'missing-device')
      issues.push({ type: 'missing-device', severity: '错误', ruleIds: [r.id], title: `${r.id} 引用缺失设备`, detail: `引用了台账中不存在的设备 ${missing.join('、')}，动作无法下发。`, suggestion: '在设备台账补全点位，或在矩阵中修正引用。' })
    }
  }

  // 2) 联动环
  const validRules = enabled.filter((r) => deviceIds.has(r.triggerId) && deviceIds.has(r.actionId))
  detectCycleSccs(validRules).forEach((scc) => {
    for (const id of scc) if (!isolated.has(id)) isolated.set(id, 'cycle')
    const ruleIds = validRules.filter((r) => scc.includes(r.triggerId) && scc.includes(r.actionId)).map((r) => r.id)
    issues.push({ type: 'cycle', severity: '错误', ruleIds, title: `${ruleIds.join('、')} 构成联动环`, detail: '环路上的动作反复触发，无法自行终止。', suggestion: '断开环路上的一条反馈规则，或改为单次触发。' })
  })

  // 3) 不动点：上游隔离 + 同动作优先级收敛
  let changed = true
  while (changed) {
    changed = false
    for (const r of enabled) {
      if (isolated.has(r.id)) continue
      const deps = cascadeDepsOf(enabled, r)
      if (deps.length > 0 && deps.every((d) => isolated.has(d))) {
        isolated.set(r.id, 'upstream-isolated')
        changed = true
      }
    }
    const groups = new Map<string, Rule[]>()
    for (const r of enabled) {
      if (isolated.has(r.id)) continue
      const list = groups.get(r.actionId) ?? []
      list.push(r)
      groups.set(r.actionId, list)
    }
    for (const [actionId, group] of groups) {
      if (group.length > 1) {
        const rep = [...group].sort((a, b) => a.priority - b.priority || a.delay - b.delay || a.id.localeCompare(b.id))[0]
        for (const r of group) {
          if (r.id === rep.id) continue
          if (!isolated.has(r.id)) {
            isolated.set(r.id, 'duplicate-action')
            changed = true
          }
        }
      }
    }
  }

  const steps: Step[] = enabled.map((r) => {
    const reason = isolated.get(r.id)
    return {
      id: r.id,
      ruleId: r.id,
      triggerId: r.triggerId,
      actionId: r.actionId,
      delay: r.delay,
      priority: r.priority,
      interlock: r.interlock,
      suppression: r.suppression,
      status: reason ? 'isolated' : 'pending',
      isolateReason: reason,
      depRuleIds: cascadeDepsOf(validRules, r),
      plannedAt: 0,
    }
  })

  // 可执行步骤排期：入口步骤延时 = delay；级联步骤 = min(上游完成时刻) + delay
  const executable = steps.filter((s) => !s.isolateReason)
  const byId = new Map(executable.map((s) => [s.id, s]))
  const memo = new Map<string, number>()
  function planned(s: Step): number {
    if (memo.has(s.id)) return memo.get(s.id)!
    const deps = s.depRuleIds.map((id) => byId.get(id)).filter((x): x is Step => !!x)
    const t = deps.length === 0 ? s.delay : Math.min(...deps.map(planned)) + s.delay
    memo.set(s.id, t)
    return t
  }
  for (const s of executable) s.plannedAt = planned(s)

  steps.sort((a, b) => a.plannedAt - b.plannedAt || a.priority - b.priority || a.id.localeCompare(b.id))

  return { steps, issues, executableCount: executable.length, isolatedCount: steps.length - executable.length }
}

// 依赖图布局：分层 DAG，环路用红色回边标注
export type GraphNode = { id: string; kind: 'trigger' | 'action' | 'both'; layer: number; order: number; x: number; y: number }
export type GraphEdge = { id: string; from: string; to: string; cycle: boolean; back: boolean; priority: number; delay: number }

export type GraphLayout = {
  nodes: GraphNode[]
  edges: GraphEdge[]
  cyclicNodeIds: string[]
  layerCount: number
}

export function layoutGraph(devices: Device[], rules: Rule[]): GraphLayout {
  const deviceIds = new Set(devices.map((d) => d.id))
  const enabled = rules.filter((r) => r.enabled && deviceIds.has(r.triggerId) && deviceIds.has(r.actionId))
  const triggerIds = new Set(enabled.map((r) => r.triggerId))
  const actionIds = new Set(enabled.map((r) => r.actionId))
  const nodeIds = [...new Set([...triggerIds, ...actionIds])]

  const outgoing = new Map<string, string[]>()
  const incoming = new Map<string, string[]>()
  for (const id of nodeIds) {
    outgoing.set(id, [])
    incoming.set(id, [])
  }
  for (const r of enabled) {
    outgoing.get(r.triggerId)!.push(r.actionId)
    incoming.get(r.actionId)!.push(r.triggerId)
  }

  const sccs = tarjan(nodeIds, (id) => outgoing.get(id) ?? [])
  const cyclicNodeIds = new Set<string>()
  for (const scc of sccs) {
    if (scc.length > 1) scc.forEach((n) => cyclicNodeIds.add(n))
    else {
      const n = scc[0]
      if (outgoing.get(n)?.includes(n)) cyclicNodeIds.add(n)
    }
  }

  const cycleEdgeSet = new Set<string>()
  for (const r of enabled) {
    if (cyclicNodeIds.has(r.triggerId) && cyclicNodeIds.has(r.actionId)) cycleEdgeSet.add(`${r.triggerId}->${r.actionId}`)
  }

  const memo = new Map<string, number>()
  function layerOf(n: string): number {
    if (memo.has(n)) return memo.get(n)!
    const preds = (incoming.get(n) ?? []).filter((p) => !cycleEdgeSet.has(`${p}->${n}`))
    const L = preds.length === 0 ? 0 : 1 + Math.max(...preds.map(layerOf))
    memo.set(n, L)
    return L
  }
  for (const n of nodeIds) layerOf(n)

  const layers = new Map<number, string[]>()
  for (const n of nodeIds) {
    const L = memo.get(n)!
    if (!layers.has(L)) layers.set(L, [])
    layers.get(L)!.push(n)
  }
  for (const list of layers.values()) list.sort((a, b) => a.localeCompare(b))
  const order = new Map<string, number>()
  for (const list of layers.values()) list.forEach((n, i) => order.set(n, i))

  const COL_W = 300
  const ROW_H = 104
  const nodes: GraphNode[] = nodeIds.map((id) => {
    const L = memo.get(id)!
    const kind = triggerIds.has(id) && actionIds.has(id) ? 'both' : triggerIds.has(id) ? 'trigger' : 'action'
    return { id, kind, layer: L, order: order.get(id)!, x: 60 + L * COL_W, y: 70 + order.get(id)! * ROW_H }
  })

  const edges: GraphEdge[] = enabled.map((r) => ({
    id: r.id,
    from: r.triggerId,
    to: r.actionId,
    cycle: cycleEdgeSet.has(`${r.triggerId}->${r.actionId}`),
    back: (memo.get(r.triggerId) ?? 0) >= (memo.get(r.actionId) ?? 0),
    priority: r.priority,
    delay: r.delay,
  }))

  return { nodes, edges, cyclicNodeIds: [...cyclicNodeIds], layerCount: layers.size }
}
