<script setup lang="ts">
import { computed, ref } from 'vue'
import { useLinkageStore } from '../stores/linkage'
import type { GraphEdge, GraphNode, PathCandidate } from '../linkage/commissioning'

const store = useLinkageStore()
const selectedNodeId = ref<string | null>(null)
const selectedEdgeId = ref<string | null>(null)
const selectedPathKey = ref<string | null>(null)

interface PlacedNode {
  id: string
  name: string
  sub: string
  x: number
  y: number
  kind: string
  quarantined: boolean
  ghost?: boolean
}

const graph = computed(() => store.commissionGraph)

const layers = computed(() => {
  const executableEdges = graph.value.edges.filter((edge) => edge.state === 'executable')
  const indegree = new Map<string, number>()
  graph.value.nodes.forEach((node) => indegree.set(node.id, 0))
  executableEdges.forEach((edge) => indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1))
  let remaining = [...indegree.entries()].filter(([id]) => !graph.value.quarantinedNodeIds.has(id))
  let level = 0
  const layerMap = new Map<string, number>()
  while (remaining.length) {
    const current = remaining.filter(([, degree]) => degree === 0).map(([id]) => id)
    if (!current.length) break
    current.forEach((id) => layerMap.set(id, level))
    remaining = remaining.filter(([id]) => !current.includes(id))
    executableEdges.forEach((edge) => {
      if (current.includes(edge.source) && indegree.has(edge.target) && !graph.value.quarantinedNodeIds.has(edge.target)) {
        indegree.set(edge.target, Math.max(0, (indegree.get(edge.target) ?? 1) - 1))
      }
    })
    level += 1
  }
  return layerMap
})

const normalNodes = computed(() => graph.value.nodes.filter((node) => !node.quarantined && layers.value.has(node.id)))
const specialNodes = computed(() => graph.value.nodes.filter((node) => node.quarantined || !layers.value.has(node.id)))
const normalGroups = computed(() => {
  const groups = new Map<number, GraphNode[]>()
  normalNodes.value.forEach((node) => {
    const layer = layers.value.get(node.id) ?? 0
    groups.set(layer, [...(groups.get(layer) ?? []), node].sort((a, b) => a.id.localeCompare(b.id)))
  })
  return groups
})
const maxRows = computed(() => Math.max(5, ...[...normalGroups.value.values()].map((group) => group.length)))
const cycleCount = computed(() => graph.value.issues.filter((issue) => issue.code === 'cycle').length)
const missingCount = computed(() => graph.value.issues.filter((issue) => issue.code === 'missing-device').length)
const duplicateCount = computed(() => graph.value.issues.filter((issue) => issue.code === 'duplicate-action').length)

const missingGhosts = computed(() => {
  const sourceIds = new Set<string>()
  const targetIds = new Set<string>()
  graph.value.edges.filter((edge) => edge.state === 'missing-device').forEach((edge) => {
    if (!graph.value.nodeMap.has(edge.source)) sourceIds.add(edge.source)
    if (!graph.value.nodeMap.has(edge.target)) targetIds.add(edge.target)
  })
  return {
    sources: [...sourceIds].sort(),
    targets: [...targetIds].sort(),
  }
})

const placedNodes = computed<Map<string, PlacedNode>>(() => {
  const result = new Map<string, PlacedNode>()
  normalGroups.value.forEach((nodes, layer) => {
    nodes.forEach((node, index) => {
      const y = 70 + index * 96
      result.set(node.id, {
        id: node.id,
        name: node.device.name,
        sub: `${node.id} · ${node.device.zone}`,
        x: 50 + layer * 285,
        y,
        kind: node.kind,
        quarantined: false,
      })
    })
  })

  const specialY = Math.max(350, maxRows.value * 96 + 70)
  specialNodes.value.filter((node) => node.quarantined).forEach((node, index) => {
    result.set(node.id, {
      id: node.id,
      name: node.device.name,
      sub: `${node.id} · 闭环隔离`,
      x: 50 + (index % 4) * 285,
      y: specialY + Math.floor(index / 4) * 92,
      kind: node.kind,
      quarantined: true,
    })
  })

  const ghostY = specialY + 230
  missingGhosts.value.sources.forEach((id, index) => result.set(id, {
    id, name: id, sub: '缺失触发设备', x: 50, y: ghostY + index * 82, kind: 'trigger', quarantined: false, ghost: true,
  }))
  missingGhosts.value.targets.forEach((id, index) => result.set(id, {
    id, name: id, sub: '缺失动作设备', x: Math.max(905, ...normalNodes.value.map((node) => (layers.value.get(node.id) ?? 0) * 285 + 50)), y: ghostY + index * 82, kind: 'action', quarantined: false, ghost: true,
  }))
  return result
})

const selectedNode = computed(() => selectedNodeId.value ? graph.value.nodeMap.get(selectedNodeId.value) : undefined)
const selectedEdge = computed(() => selectedEdgeId.value ? graph.value.edgeMap.get(selectedEdgeId.value) : undefined)
const selectedRule = computed(() => {
  const id = selectedEdge.value?.ruleId ?? (selectedPath.value?.edgeIds[0] && graph.value.edgeMap.get(selectedPath.value.edgeIds[0])?.ruleId)
  return store.rules.find((rule) => rule.id === id)
})
const selectedPaths = computed<PathCandidate[]>(() => selectedNodeId.value ? graph.value.pathsByTarget.get(selectedNodeId.value) ?? [] : [])
const selectedPath = computed(() => selectedPaths.value.find((path) => path.key === selectedPathKey.value) ?? selectedPaths.value[0])
const highlightedEdgeIds = computed(() => new Set(selectedPath.value?.edgeIds ?? []))

function edgePath(edge: GraphEdge) {
  const source = placedNodes.value.get(edge.source)
  const target = placedNodes.value.get(edge.target)
  if (!source || !target) return ''
  const x1 = source.x + 225
  const y1 = source.y
  const x2 = target.x
  const y2 = target.y
  return `M ${x1} ${y1} C ${x1 + 70} ${y1}, ${x2 - 70} ${y2}, ${x2} ${y2}`
}

function labelX(edge: GraphEdge) {
  const source = placedNodes.value.get(edge.source)
  const target = placedNodes.value.get(edge.target)
  return source && target ? (source.x + 225 + target.x) / 2 : 0
}

function labelY(edge: GraphEdge) {
  const source = placedNodes.value.get(edge.source)
  const target = placedNodes.value.get(edge.target)
  return source && target ? (source.y + target.y) / 2 : 0
}

function selectNode(id: string) {
  selectedNodeId.value = id
  selectedEdgeId.value = null
  selectedPathKey.value = null
}

function selectEdge(edge: GraphEdge) {
  selectedEdgeId.value = edge.id
  selectedNodeId.value = null
}

function pathText(path: PathCandidate) {
  return path.nodeIds.map((id) => graph.value.nodeMap.get(id)?.device.name ?? id).join(' → ')
}
</script>

<template>
  <section class="page">
    <div class="page-head">
      <div>
        <p class="eyebrow">DEPENDENCY GRAPH / 可执行依赖</p>
        <h1>触发、动作、回执与隔离路径</h1>
        <p class="muted">开始前的成环、缺失设备和重复动作会直接标在图上；同一动作的候选路径按最高优先级排序。</p>
      </div>
      <div class="status-chips">
        <v-chip variant="tonal" color="error" prepend-icon="mdi-alert-circle-outline">{{ cycleCount }} 个环</v-chip>
        <v-chip variant="tonal" color="warning" prepend-icon="mdi-link-variant-off">{{ missingCount }} 条缺失</v-chip>
        <v-chip variant="tonal" prepend-icon="mdi-content-copy">{{ duplicateCount }} 组重复</v-chip>
      </div>
    </div>

    <div class="graph-wrap panel">
      <svg :viewBox="`0 0 1240 ${Math.max(720, maxRows * 96 + 420)}`" preserveAspectRatio="xMinYMin meet">
        <defs>
          <marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#4e7078" /></marker>
          <marker id="arrow-warn" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#bd6f2a" /></marker>
          <marker id="arrow-error" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#b23e2a" /></marker>
          <marker id="arrow-priority" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#1e6772" /></marker>
        </defs>
        <text x="50" y="25" class="column-title">报警源 / 上游反馈</text>
        <text x="910" y="25" class="column-title">下游动作</text>

        <g v-for="edge in graph.edges" :key="edge.id" class="edge-group" @click="selectEdge(edge)">
          <path
            :d="edgePath(edge)"
            fill="none"
            :class="['edge', edge.state, { selected: selectedEdgeId === edge.id, priority: highlightedEdgeIds.has(edge.id) }]"
            :marker-end="edge.state === 'executable' ? highlightedEdgeIds.has(edge.id) ? 'url(#arrow-priority)' : 'url(#arrow)' : edge.state === 'duplicate' ? 'url(#arrow-warn)' : 'url(#arrow-error)'"
          />
          <g v-if="placedNodes.has(edge.source) && placedNodes.has(edge.target)">
            <rect :x="labelX(edge) - 34" :y="labelY(edge) - 22" width="68" height="20" rx="10" class="edge-label-bg" :class="edge.state" />
            <text :x="labelX(edge)" :y="labelY(edge) - 8" text-anchor="middle" class="edge-label">{{ edge.ruleId }} · P{{ edge.priority }}</text>
          </g>
        </g>

        <g v-for="node in [...placedNodes.values()]" :key="node.id" class="node-group" @click="selectNode(node.id)">
          <rect
            :x="node.x"
            :y="node.y - 28"
            width="225"
            height="56"
            rx="9"
            :class="['node', node.kind, { quarantine: node.quarantined, ghost: node.ghost, selected: selectedNodeId === node.id }]"
          />
          <text :x="node.x + 15" :y="node.y - 5" class="node-title">{{ node.name }}</text>
          <text :x="node.x + 15" :y="node.y + 14" class="node-sub">{{ node.sub }}</text>
          <text v-if="node.quarantined" :x="node.x + 200" :y="node.y - 10" text-anchor="end" class="node-badge">环</text>
          <text v-else-if="node.ghost" :x="node.x + 200" :y="node.y - 10" text-anchor="end" class="node-badge warning">缺</text>
        </g>
      </svg>

      <aside class="graph-side">
        <div class="side-head">
          <strong>{{ selectedEdge ? selectedEdge.ruleId : selectedNode?.device.name ?? '路径说明' }}</strong>
          <v-btn icon="mdi-close" size="small" variant="text" @click="selectedNodeId = selectedEdgeId = selectedPathKey = null" />
        </div>

        <template v-if="selectedEdge">
          <p>{{ graph.nodeMap.get(selectedEdge.source)?.device.name ?? selectedEdge.source }} → {{ graph.nodeMap.get(selectedEdge.target)?.device.name ?? selectedEdge.target }}</p>
          <v-chip size="small" :color="selectedEdge.state === 'executable' ? 'success' : 'error'" variant="tonal">
            {{ { executable: '可执行', 'missing-device': '缺失设备', duplicate: '重复隔离', cycle: '闭环隔离', blocked: '闭环阻断' }[selectedEdge.state] }}
          </v-chip>
          <small class="side-reason">{{ selectedEdge.reason || '通过开始前检查，可进入联调排程。' }}</small>
          <template v-if="selectedRule">
            <v-select :model-value="selectedRule.priority" :items="[1,2,3]" label="优先级" density="compact" :disabled="store.locked" @update:model-value="store.updateRule(selectedRule.id, { priority: Number($event) as 1|2|3 })" />
            <v-text-field :model-value="selectedRule.interlock" label="互锁条件" density="compact" :disabled="store.locked" @update:model-value="store.updateRule(selectedRule.id, { interlock: String($event) })" />
            <v-switch :model-value="selectedRule.enabled" label="规则启用" color="primary" :disabled="store.locked" @update:model-value="store.updateRule(selectedRule.id, { enabled: Boolean($event) })" />
          </template>
        </template>

        <template v-else-if="selectedNode">
          <p>{{ selectedNode.id }} · {{ selectedNode.device.zone }}</p>
          <small>该动作有 {{ selectedPaths.length }} 条候选路径。路径等级取沿途最低优先级，等级相同时累计延时更短者先执行。</small>
          <div v-if="selectedPaths.length" class="path-list">
            <button
              v-for="(path, index) in selectedPaths.slice(0, 6)"
              :key="path.key"
              type="button"
              :class="{ active: selectedPath?.key === path.key }"
              @click="selectedPathKey = path.key"
            >
              <b>#{{ index + 1 }} · P{{ path.rank }} · {{ path.totalDelay }}s</b>
              <span>{{ pathText(path) }}</span>
            </button>
          </div>
          <v-alert v-else density="compact" type="info" variant="tonal">没有可执行候选路径，查看左侧问题或联调账隔离清单。</v-alert>
        </template>

        <template v-else>
          <p>灰色为普通触发→动作；动作设备再次触发时会继续展开下游。</p>
          <ul>
            <li><i class="executable" />可执行路径</li>
            <li><i class="cycle" />成环/阻断路径</li>
            <li><i class="missing-device" />缺失设备</li>
            <li><i class="duplicate" />重复动作</li>
            <li><i class="priority-line" />当前最高优先级路径</li>
          </ul>
        </template>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.status-chips { display: flex; gap: 8px; flex-wrap: wrap; }
.graph-wrap { position: relative; overflow: auto; }
svg { display: block; min-width: 980px; width: 100%; background: radial-gradient(circle, #d9dfe0 1px, transparent 1px); background-size: 22px 22px; }
.column-title { fill: #64757c; font-size: 13px; font-weight: 800; letter-spacing: .12em; }
.node { fill: white; stroke-width: 1.7; cursor: pointer; }
.node.trigger { stroke: #397a82; }
.node.action { stroke: #a64c35; }
.node.both { stroke: #67519a; }
.node.quarantine { fill: #fff3ef; stroke: #b23e2a; stroke-dasharray: 6 4; }
.node.ghost { fill: #f7f7f7; stroke: #9aa3a6; stroke-dasharray: 4 4; }
.node.selected { stroke-width: 4; }
.node-title { fill: #253a42; font-size: 12px; font-weight: 700; }
.node-sub { fill: #718188; font-size: 10px; }
.node-badge { fill: #b23e2a; font-size: 11px; font-weight: 900; }
.node-badge.warning { fill: #bd6f2a; }
.edge { stroke-width: 2; opacity: .72; cursor: pointer; }
.edge.executable { stroke: #60777e; }
.edge.cycle, .edge.blocked { stroke: #b23e2a; stroke-dasharray: 7 5; }
.edge.missing-device { stroke: #8d989d; stroke-dasharray: 3 5; }
.edge.duplicate { stroke: #bd6f2a; stroke-dasharray: 8 4; }
.edge.selected, .edge.priority { stroke: #1e6772; stroke-width: 4; opacity: 1; }
.edge-label-bg { fill: white; stroke-width: 1; }
.edge-label-bg.executable { stroke: #8ea4a9; }
.edge-label-bg.cycle, .edge-label-bg.blocked { stroke: #d08a7e; }
.edge-label-bg.missing-device { stroke: #c4cbce; }
.edge-label-bg.duplicate { stroke: #d7a25f; }
.edge-label { fill: #4f666d; font-size: 9px; font-weight: 800; }
.graph-side { position: absolute; top: 18px; right: 18px; width: 315px; max-height: calc(100% - 36px); overflow: auto; padding: 14px; border: 1px solid #dbe2e3; border-radius: 9px; background: rgba(255,255,255,.97); box-shadow: 0 8px 25px rgba(31,54,62,.14); }
.side-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.side-head strong { font-size: 14px; }
.graph-side p { margin: 10px 0; color: #334a52; font-size: 12px; line-height: 1.5; }
.graph-side small { display: block; margin: 10px 0; color: #6e7c82; font-size: 11px; line-height: 1.5; }
.graph-side ul { margin: 8px 0 0; padding: 0; list-style: none; display: grid; gap: 8px; font-size: 12px; }
.graph-side li { display: flex; align-items: center; gap: 8px; }
.graph-side i { width: 28px; height: 3px; border-radius: 3px; }
i.executable { background: #60777e; }
i.cycle { background: #b23e2a; }
i.missing-device { background: #8d989d; }
i.duplicate { background: #bd6f2a; }
i.priority-line { background: #1e6772; height: 5px; }
.path-list { display: grid; gap: 7px; }
.path-list button { padding: 8px; border: 1px solid #dfe5e6; border-radius: 7px; background: #fafbfb; text-align: left; cursor: pointer; }
.path-list button.active { border-color: #1e6772; background: #edf7f8; }
.path-list b, .path-list span { display: block; }
.path-list b { color: #1e6772; font-size: 11px; }
.path-list span { margin-top: 4px; color: #5d6b71; font-size: 10px; line-height: 1.4; }
</style>
