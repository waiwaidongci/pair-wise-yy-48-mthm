import type { Device, Rule } from '../stores/linkage'

export type IssueCode = 'cycle' | 'missing-device' | 'duplicate-action'
export type EdgeState = 'executable' | 'missing-device' | 'duplicate' | 'cycle' | 'blocked'
export type ReceiptStatus = 'trigger' | 'completed' | 'failed' | 'paused' | 'quarantined' | 'isolated'
export type RunStatus = 'completed' | 'paused' | 'superseded'

export interface PreflightIssue {
  id: string
  code: IssueCode
  severity: '错误' | '警告'
  title: string
  detail: string
  suggestion: string
  ruleIds: string[]
  edgeIds: string[]
  nodeIds: string[]
}

export interface GraphEdge {
  id: string
  ruleId: string
  source: string
  target: string
  priority: 1 | 2 | 3
  delay: number
  state: EdgeState
  reason: string
  duplicateOf?: string
}

export interface GraphNode {
  id: string
  device: Device
  kind: 'trigger' | 'action' | 'both'
  outgoing: string[]
  incoming: string[]
  quarantined: boolean
}

export interface PathCandidate {
  key: string
  rootId: string
  edgeIds: string[]
  nodeIds: string[]
  rank: 1 | 2 | 3
  totalDelay: number
}

export interface CommissionGraph {
  configHash: string
  nodes: GraphNode[]
  nodeMap: Map<string, GraphNode>
  edges: GraphEdge[]
  edgeMap: Map<string, GraphEdge>
  issues: PreflightIssue[]
  quarantinedNodeIds: Set<string>
  executableEdgeIds: Set<string>
  defaultRootIds: string[]
  pathsByTarget: Map<string, PathCandidate[]>
}

export interface ReceiptAttempt {
  status: ReceiptStatus
  atSecond: number
  ruleId?: string
  reason?: string
}

export interface ActionReceipt {
  id: string
  deviceId: string
  status: ReceiptStatus
  attempts: ReceiptAttempt[]
  pathEdgeIds: string[]
  rootIds: string[]
  rank: 1 | 2 | 3 | null
  terminalRuleId?: string
  reason?: string
  blockedBy?: string
  recovered?: boolean
}

export type LedgerEventType = ReceiptStatus | 'isolate' | 'resume' | 'supersede'

export interface LedgerEvent {
  seq: number
  atSecond: number
  type: LedgerEventType
  deviceId?: string
  edgeId?: string
  message: string
}

export interface CommissionRun {
  id: string
  revision: number
  configHash: string
  createdAt: string
  rootIds: string[]
  status: RunStatus
  devices: Device[]
  rules: Rule[]
  issues: PreflightIssue[]
  receipts: ActionReceipt[]
  events: LedgerEvent[]
  isolatedEdgeIds: string[]
  quarantinedNodeIds: string[]
}

const TRIGGER_TYPES = ['感烟探测器', '感温探测器', '手动报警按钮', '输入模块']

export function isTriggerDevice(type: Device['type']) {
  return TRIGGER_TYPES.includes(type)
}

export function stableConfigHash(devices: Device[], rules: Rule[]) {
  const payload = JSON.stringify({
    devices: [...devices].sort((a, b) => a.id.localeCompare(b.id)),
    rules: [...rules].sort((a, b) => a.id.localeCompare(b.id)),
  })
  let h1 = 0xdeadbeef ^ payload.length
  let h2 = 0x41c6ce57 ^ payload.length
  for (let i = 0; i < payload.length; i += 1) {
    const ch = payload.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return `${(h2 >>> 0).toString(36)}${(h1 >>> 0).toString(36)}`.padStart(14, '0')
}

function comparePath(a: PathCandidate, b: PathCandidate) {
  return a.rank - b.rank
    || a.totalDelay - b.totalDelay
    || a.rootId.localeCompare(b.rootId)
    || a.edgeIds.join('>').localeCompare(b.edgeIds.join('>'))
}

function findCyclePath(members: Set<string>, adjacency: Map<string, string[]>) {
  const starts = [...members].sort()
  for (const start of starts) {
    const path: string[] = []
    const dfs = (node: string): string[] | undefined => {
      path.push(node)
      for (const next of adjacency.get(node) ?? []) {
        if (!members.has(next)) continue
        if (path.includes(next)) {
          const index = path.indexOf(next)
          return [...path.slice(index), next]
        }
        const found = dfs(next)
        if (found) return found
      }
      path.pop()
      return undefined
    }
    const found = dfs(start)
    if (found) return found
  }
  return [...starts, starts[0]]
}

export function buildCommissioningGraph(devices: Device[], rules: Rule[]): CommissionGraph {
  const configHash = stableConfigHash(devices, rules)
  const deviceMap = new Map(devices.map((device) => [device.id, device]))
  const enabledRules = rules.filter((rule) => rule.enabled)
  const nodeMap = new Map<string, GraphNode>()

  const ensureNode = (id: string, role: 'trigger' | 'action') => {
    const device = deviceMap.get(id)
    if (!device) return
    const existing = nodeMap.get(id)
    if (existing) {
      existing.kind = existing.kind === role || existing.kind === 'both'
        ? existing.kind
        : 'both'
      return
    }
    nodeMap.set(id, { id, device, kind: role, outgoing: [], incoming: [], quarantined: false })
  }

  for (const rule of enabledRules) {
    ensureNode(rule.triggerId, 'trigger')
    ensureNode(rule.actionId, 'action')
  }

  const edges: GraphEdge[] = enabledRules.map((rule) => {
    const missing: string[] = []
    if (!deviceMap.has(rule.triggerId)) missing.push(`触发设备 ${rule.triggerId}`)
    if (!deviceMap.has(rule.actionId)) missing.push(`动作设备 ${rule.actionId}`)
    return {
      id: rule.id,
      ruleId: rule.id,
      source: rule.triggerId,
      target: rule.actionId,
      priority: rule.priority,
      delay: rule.delay,
      state: missing.length ? 'missing-device' : 'executable',
      reason: missing.length ? `${missing.join('、')} 不在设备台账` : '',
    }
  })

  const duplicateGroups = new Map<string, GraphEdge[]>()
  for (const edge of edges) {
    if (edge.state === 'missing-device') continue
    const key = `${edge.source}>${edge.target}`
    duplicateGroups.set(key, [...(duplicateGroups.get(key) ?? []), edge])
  }
  duplicateGroups.forEach((group) => {
    if (group.length < 2) return
    const sorted = [...group].sort((a, b) => a.priority - b.priority || a.delay - b.delay || a.id.localeCompare(b.id))
    const [winner, ...losers] = sorted
    losers.forEach((edge) => {
      edge.state = 'duplicate'
      edge.duplicateOf = winner.ruleId
      edge.reason = `重复动作已隔离，保留高优先级规则 ${winner.ruleId}`
    })
  })

  const adjacency = new Map<string, string[]>()
  for (const edge of edges) {
    if (edge.state !== 'executable') continue
    adjacency.set(edge.source, [...(adjacency.get(edge.source) ?? []), edge.target])
  }

  let tarjanIndex = 0
  const indices = new Map<string, number>()
  const low = new Map<string, number>()
  const stack: string[] = []
  const onStack = new Set<string>()
  const cyclicGroups: Set<string>[] = []

  const connect = (node: string) => {
    indices.set(node, tarjanIndex)
    low.set(node, tarjanIndex)
    tarjanIndex += 1
    stack.push(node)
    onStack.add(node)

    for (const next of adjacency.get(node) ?? []) {
      if (!indices.has(next)) {
        connect(next)
        low.set(node, Math.min(low.get(node)!, low.get(next)!))
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node)!, indices.get(next)!))
      }
    }

    if (low.get(node) === indices.get(node)) {
      const component = new Set<string>()
      let current = ''
      do {
        current = stack.pop()!
        onStack.delete(current)
        component.add(current)
      } while (current !== node)
      const hasSelfLoop = (adjacency.get(node) ?? []).includes(node)
      if (component.size > 1 || hasSelfLoop) cyclicGroups.push(component)
    }
  }
  nodeMap.forEach((_node, id) => connect(id))

  const quarantinedNodeIds = new Set<string>()
  cyclicGroups.forEach((group) => group.forEach((id) => quarantinedNodeIds.add(id)))
  quarantinedNodeIds.forEach((id) => {
    const node = nodeMap.get(id)
    if (node) node.quarantined = true
  })

  for (const edge of edges) {
    if (edge.state === 'missing-device' || edge.state === 'duplicate') continue
    const sourceCyclic = quarantinedNodeIds.has(edge.source)
    const targetCyclic = quarantinedNodeIds.has(edge.target)
    if (sourceCyclic && targetCyclic) {
      edge.state = 'cycle'
      edge.reason = '规则两端位于同一依赖闭环'
    } else if (sourceCyclic || targetCyclic) {
      edge.state = 'blocked'
      edge.reason = targetCyclic ? '目标动作位于依赖闭环内' : '上游动作位于依赖闭环内'
    } else {
      edge.state = 'executable'
    }
  }

  for (const edge of edges) {
    const source = nodeMap.get(edge.source)
    const target = nodeMap.get(edge.target)
    if (source) source.outgoing.push(edge.id)
    if (target) target.incoming.push(edge.id)
  }

  const edgeMap = new Map(edges.map((edge) => [edge.id, edge]))
  const executableEdges = edges.filter((edge) => edge.state === 'executable')
  const executableEdgeIds = new Set(executableEdges.map((edge) => edge.id))
  const defaultRootIds = [...nodeMap.values()]
    .filter((node) => isTriggerDevice(node.device.type) && node.outgoing.length > 0)
    .map((node) => node.id)
    .sort((a, b) => a.localeCompare(b))

  const pathsByTarget = new Map<string, PathCandidate[]>()
  const executableOut = new Map<string, GraphEdge[]>()
  for (const edge of executableEdges) {
    executableOut.set(edge.source, [...(executableOut.get(edge.source) ?? []), edge])
  }
  executableOut.forEach((group) => group.sort((a, b) => a.priority - b.priority || a.delay - b.delay || a.id.localeCompare(b.id)))

  for (const rootId of defaultRootIds) {
    const visited = new Set<string>([rootId])
    const walk = (current: string, nodeIds: string[], edgeIds: string[], totalDelay: number, rank: 1 | 2 | 3) => {
      if (current !== rootId) {
        const path: PathCandidate = {
          key: `${rootId}:${edgeIds.join('>')}`,
          rootId,
          edgeIds: [...edgeIds],
          nodeIds: [...nodeIds],
          rank,
          totalDelay,
        }
        pathsByTarget.set(current, [...(pathsByTarget.get(current) ?? []), path])
      }
      for (const edge of executableOut.get(current) ?? []) {
        if (visited.has(edge.target)) continue
        visited.add(edge.target)
        walk(
          edge.target,
          [...nodeIds, edge.target],
          [...edgeIds, edge.id],
          totalDelay + edge.delay,
          Math.max(rank, edge.priority) as 1 | 2 | 3,
        )
        visited.delete(edge.target)
      }
    }
    walk(rootId, [rootId], [], 0, 1)
  }
  pathsByTarget.forEach((paths) => paths.sort(comparePath))

  const name = (id: string) => deviceMap.get(id)?.name ?? id
  const issues: PreflightIssue[] = []

  for (const group of cyclicGroups) {
    const cycle = findCyclePath(group, adjacency)
    const internalEdges = edges
      .filter((edge) => group.has(edge.source) && group.has(edge.target))
      .sort((a, b) => a.id.localeCompare(b.id))
    issues.push({
      id: `cycle-${[...group].sort().join('-')}`,
      code: 'cycle',
      severity: '错误',
      title: `依赖成环：${cycle.map(name).join(' → ')}`,
      detail: `${cycle.slice(0, -1).map(name).join('、')} 通过 ${internalEdges.map((edge) => edge.ruleId).join('、')} 形成闭环，闭环内动作无法确定先后顺序，已整环隔离。`,
      suggestion: '将回授边改为单向反馈条件，或删除回到上游动作的规则。',
      ruleIds: internalEdges.map((edge) => edge.ruleId),
      edgeIds: internalEdges.map((edge) => edge.id),
      nodeIds: cycle,
    })
  }

  for (const edge of edges.filter((item) => item.state === 'missing-device')) {
    issues.push({
      id: `missing-device-${edge.id}`,
      code: 'missing-device',
      severity: '错误',
      title: `${edge.ruleId} 引用缺失设备`,
      detail: edge.reason,
      suggestion: '在设备台账补齐点位，或将该规则改接到已在线设备。',
      ruleIds: [edge.ruleId],
      edgeIds: [edge.id],
      nodeIds: [edge.source, edge.target].filter((id) => deviceMap.has(id)),
    })
  }

  duplicateGroups.forEach((group) => {
    if (group.length < 2) return
    const sorted = [...group].sort((a, b) => a.priority - b.priority || a.delay - b.delay || a.id.localeCompare(b.id))
    const winner = sorted[0]
    issues.push({
      id: `duplicate-${winner.source}-${winner.target}`,
      code: 'duplicate-action',
      severity: '警告',
      title: `${name(winner.source)} 到 ${name(winner.target)} 存在重复动作`,
      detail: `${sorted.map((edge) => edge.ruleId).join('、')} 命中同一动作；按优先级、延时和规则号保留 ${winner.ruleId}，其余规则不重复下发。`,
      suggestion: '合并重复规则，或把备用动作明确拆成不同设备和反馈条件。',
      ruleIds: sorted.map((edge) => edge.ruleId),
      edgeIds: sorted.map((edge) => edge.id),
      nodeIds: [winner.source, winner.target],
    })
  })

  issues.sort((a, b) => {
    const severityRank = a.severity === '错误' ? 0 : 1
    const otherRank = b.severity === '错误' ? 0 : 1
    return severityRank - otherRank || a.id.localeCompare(b.id)
  })

  return {
    configHash,
    nodes: [...nodeMap.values()].sort((a, b) => a.id.localeCompare(b.id)),
    nodeMap,
    edges: [...edges].sort((a, b) => a.id.localeCompare(b.id)),
    edgeMap,
    issues,
    quarantinedNodeIds,
    executableEdgeIds,
    defaultRootIds,
    pathsByTarget,
  }
}

function makeRunId() {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase()
  return `RUN-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${suffix}`
}

function firstAt(receipt: ActionReceipt) {
  return receipt.attempts[0]?.atSecond ?? 0
}

function lastAt(receipt: ActionReceipt) {
  return receipt.attempts.at(-1)?.atSecond ?? 0
}

function sortReceipts(receipts: Map<string, ActionReceipt>) {
  return [...receipts.values()].sort((a, b) => firstAt(a) - firstAt(b) || a.deviceId.localeCompare(b.deviceId))
}

function eventOrder(type: LedgerEventType) {
  return { trigger: 0, isolate: 1, resume: 2, completed: 3, failed: 4, paused: 5, quarantined: 1, isolated: 1, supersede: 6 }[type]
}

function selectPathGroups(graph: CommissionGraph, rootIds: string[]) {
  const roots = new Set(rootIds)
  const groups = new Map<string, PathCandidate[]>()
  graph.pathsByTarget.forEach((paths, target) => {
    const selected = paths.filter((path) => roots.has(path.rootId))
    if (selected.length) groups.set(target, selected)
  })
  return groups
}

function scheduleActions(
  graph: CommissionGraph,
  rootIds: string[],
  receiptMap: Map<string, ActionReceipt>,
  events: LedgerEvent[],
  startSeq: number,
  options: { failDeviceId?: string; notBefore?: number } = {},
) {
  const groups = selectPathGroups(graph, rootIds)
  const name = (id: string) => graph.nodeMap.get(id)?.device.name ?? id
  let seq = startSeq
  let changed = true

  const pushEvent = (atSecond: number, type: LedgerEventType, message: string, deviceId?: string, edgeId?: string) => {
    events.push({ seq: seq++, atSecond, type, message, deviceId, edgeId })
  }

  while (changed) {
    changed = false
    const targetIds = [...groups.keys()].sort((a, b) => {
      const pathA = groups.get(a)![0]
      const pathB = groups.get(b)![0]
      return comparePath(pathA, pathB)
    })

    for (const target of targetIds) {
      const current = receiptMap.get(target)
      if (current && current.status !== 'paused') continue

      let activePath: PathCandidate | undefined
      let hasWaitingPath = false
      let blockedBy = ''

      for (const path of groups.get(target)!) {
        let pending = false
        let blocker = ''
        for (const nodeId of path.nodeIds.slice(0, -1)) {
          const receipt = receiptMap.get(nodeId)
          if (!receipt) {
            pending = true
            break
          }
          if (receipt.status !== 'completed' && receipt.status !== 'trigger') {
            blocker = nodeId
            break
          }
        }
        if (!pending && !blocker) {
          activePath = path
          break
        }
        if (blocker) {
          blockedBy = blocker
          continue
        }
        hasWaitingPath = true
      }

      if (activePath) {
        const terminalEdge = graph.edgeMap.get(activePath.edgeIds.at(-1)!)!
        const predecessorId = activePath.nodeIds.at(-2)!
        const predecessorAt = lastAt(receiptMap.get(predecessorId)!)
        let atSecond = predecessorAt + terminalEdge.delay
        if (options.notBefore !== undefined) atSecond = Math.max(atSecond, options.notBefore)
        const shouldFail = options.failDeviceId === target && !current
        const status = shouldFail ? 'failed' : 'completed'
        const attempt: ReceiptAttempt = {
          status,
          atSecond,
          ruleId: terminalEdge.ruleId,
          reason: shouldFail ? '现场执行失败，保留原回执并暂停下游依赖' : current ? '原回执恢复后继续，已完成动作不重做' : undefined,
        }

        if (current) {
          current.attempts.push(attempt)
          current.status = 'completed'
          current.pathEdgeIds = activePath.edgeIds
          current.rank = activePath.rank
          current.terminalRuleId = terminalEdge.ruleId
          current.reason = '从暂停点继续，未重做已完成动作'
          current.blockedBy = undefined
          current.recovered = true
        } else {
          receiptMap.set(target, {
            id: `RC-${target}`,
            deviceId: target,
            status,
            attempts: [attempt],
            pathEdgeIds: activePath.edgeIds,
            rootIds: [activePath.rootId],
            rank: activePath.rank,
            terminalRuleId: terminalEdge.ruleId,
            reason: attempt.reason,
          })
        }

        pushEvent(
          atSecond,
          status,
          shouldFail ? `${name(target)} 执行失败，仅暂停依赖它的路径` : `${name(target)} 按 ${terminalEdge.ruleId} 执行完成`,
          target,
          terminalEdge.id,
        )
        changed = true
        continue
      }

      if (!hasWaitingPath && blockedBy && (!current || current.status !== 'paused')) {
        const path = groups.get(target)![0]
        const blockerIndex = path.nodeIds.indexOf(blockedBy)
        const remainingEdges = path.edgeIds.slice(blockerIndex)
        const blockerReceipt = receiptMap.get(blockedBy)
        const atSecond = lastAt(blockerReceipt!) + remainingEdges.reduce((sum, edgeId) => sum + (graph.edgeMap.get(edgeId)?.delay ?? 0), 0)
        const reason = `上游 ${name(blockedBy)} ${blockerReceipt?.status === 'failed' ? '执行失败' : '已暂停'}，该路径暂停`
        receiptMap.set(target, {
          id: `RC-${target}`,
          deviceId: target,
          status: 'paused',
          attempts: [{ status: 'paused', atSecond, reason }],
          pathEdgeIds: path.edgeIds,
          rootIds: [path.rootId],
          rank: path.rank,
          terminalRuleId: graph.edgeMap.get(path.edgeIds.at(-1)!)?.ruleId,
          reason,
          blockedBy,
        })
        pushEvent(atSecond, 'paused', `${name(target)} 暂停：${reason}`, target)
        changed = true
      }
    }
  }
  return seq
}

export function startCommissioningRun(
  devices: Device[],
  rules: Rule[],
  revision: number,
  rootIds: string[],
  failDeviceId?: string,
): CommissionRun {
  const graph = buildCommissioningGraph(devices, rules)
  const selectedRoots = rootIds.filter((id) => graph.defaultRootIds.includes(id))
  if (!selectedRoots.length) throw new Error('请至少选择一个报警源')

  const name = (id: string) => graph.nodeMap.get(id)?.device.name ?? id
  const receiptMap = new Map<string, ActionReceipt>()
  const events: LedgerEvent[] = []
  let seq = 1

  const pushEvent = (atSecond: number, type: LedgerEventType, message: string, deviceId?: string, edgeId?: string) => {
    events.push({ seq: seq++, atSecond, type, message, deviceId, edgeId })
  }

  for (const rootId of selectedRoots) {
    receiptMap.set(rootId, {
      id: `RC-${rootId}`,
      deviceId: rootId,
      status: 'trigger',
      attempts: [{ status: 'trigger', atSecond: 0 }],
      pathEdgeIds: [],
      rootIds: [rootId],
      rank: null,
    })
    pushEvent(0, 'trigger', `${name(rootId)} 报警，联调开始`)
  }

  const reachable = new Set(selectedRoots)
  const stack = [...selectedRoots]
  while (stack.length) {
    const current = stack.pop()!
    for (const edge of graph.edges.filter((item) => item.source === current)) {
      if (edge.state === 'missing-device' || !graph.nodeMap.has(edge.target)) continue
      if (!reachable.has(edge.target)) {
        reachable.add(edge.target)
        stack.push(edge.target)
      }
    }
  }

  for (const edge of graph.edges) {
    if (edge.state === 'executable' || !reachable.has(edge.source)) continue
    pushEvent(0, 'isolate', `规则 ${edge.ruleId} 已隔离：${edge.reason}`, graph.nodeMap.get(edge.target)?.id, edge.id)
  }

  const pathGroups = selectPathGroups(graph, selectedRoots)
  for (const nodeId of reachable) {
    if (selectedRoots.includes(nodeId)) continue
    if (graph.quarantinedNodeIds.has(nodeId)) {
      receiptMap.set(nodeId, {
        id: `RC-${nodeId}`,
        deviceId: nodeId,
        status: 'quarantined',
        attempts: [{ status: 'quarantined', atSecond: 0, reason: '依赖闭环内节点禁止执行' }],
        pathEdgeIds: [],
        rootIds: [],
        rank: null,
        reason: '依赖闭环内节点禁止执行',
      })
      pushEvent(0, 'quarantined', `${name(nodeId)} 位于依赖闭环，开始前已隔离`, nodeId)
    } else if (!pathGroups.has(nodeId)) {
      receiptMap.set(nodeId, {
        id: `RC-${nodeId}`,
        deviceId: nodeId,
        status: 'isolated',
        attempts: [{ status: 'isolated', atSecond: 0, reason: '仅能通过缺失、重复或成环路径到达' }],
        pathEdgeIds: [],
        rootIds: [],
        rank: null,
        reason: '没有来自已选报警源的可执行路径',
      })
      pushEvent(0, 'isolated', `${name(nodeId)} 无可执行路径，按隔离处理`, nodeId)
    }
  }

  seq = scheduleActions(graph, selectedRoots, receiptMap, events, seq, { failDeviceId })
  events.sort((a, b) => a.atSecond - b.atSecond || eventOrder(a.type) - eventOrder(b.type) || a.seq - b.seq)
  events.forEach((event, index) => { event.seq = index + 1 })

  const receipts = sortReceipts(receiptMap)
  const status: RunStatus = receipts.some((receipt) => receipt.status === 'failed' || receipt.status === 'paused')
    ? 'paused'
    : 'completed'

  return {
    id: makeRunId(),
    revision,
    configHash: graph.configHash,
    createdAt: new Date().toISOString(),
    rootIds: selectedRoots,
    status,
    devices: structuredClone(devices),
    rules: structuredClone(rules),
    issues: structuredClone(graph.issues),
    receipts,
    events,
    isolatedEdgeIds: graph.edges.filter((edge) => edge.state !== 'executable').map((edge) => edge.id),
    quarantinedNodeIds: [...graph.quarantinedNodeIds].sort(),
  }
}

export function resumeCommissioningRun(run: CommissionRun, devices: Device[], rules: Rule[]) {
  if (run.status !== 'paused') return run
  const graph = buildCommissioningGraph(devices, rules)
  if (graph.configHash !== run.configHash) return run

  const next = structuredClone(run)
  const receiptMap = new Map(next.receipts.map((receipt) => [receipt.deviceId, receipt]))
  const name = (id: string) => graph.nodeMap.get(id)?.device.name ?? id
  const resumeAt = Math.max(0, ...next.receipts.flatMap((receipt) => receipt.attempts.map((attempt) => attempt.atSecond))) + 1
  let seq = next.events.length ? Math.max(...next.events.map((event) => event.seq)) + 1 : 1

  next.events.push({ seq: seq++, atSecond: resumeAt, type: 'resume', message: '从原回执恢复联调，已完成动作保持原回执不重做' })

  for (const receipt of receiptMap.values()) {
    if (receipt.status !== 'failed') continue
    receipt.attempts.push({
      status: 'completed',
      atSecond: resumeAt,
      ruleId: receipt.terminalRuleId,
      reason: '从原回执恢复',
    })
    receipt.status = 'completed'
    receipt.reason = '原回执恢复成功'
    receipt.recovered = true
    next.events.push({
      seq: seq++,
      atSecond: resumeAt,
      type: 'completed',
      deviceId: receipt.deviceId,
      edgeId: receipt.terminalRuleId,
      message: `${name(receipt.deviceId)} 从原回执恢复，未重新执行已完成动作`,
    })
  }

  seq = scheduleActions(graph, next.rootIds, receiptMap, next.events, seq, { notBefore: resumeAt })
  next.receipts = sortReceipts(receiptMap)
  next.status = next.receipts.some((receipt) => receipt.status === 'failed' || receipt.status === 'paused')
    ? 'paused'
    : 'completed'
  return next
}

export function markRunSuperseded(run: CommissionRun): CommissionRun {
  if (run.status !== 'paused') return run
  const next = structuredClone(run)
  const atSecond = Math.max(0, ...next.receipts.flatMap((receipt) => receipt.attempts.map((attempt) => attempt.atSecond))) + 1
  const seq = next.events.length ? Math.max(...next.events.map((event) => event.seq)) + 1 : 1
  next.status = 'superseded'
  next.events.push({
    seq,
    atSecond,
    type: 'supersede',
    message: '规则或设备台账已变更，未完成运行作废并重新排程；已完成回执继续留档',
  })
  return next
}
