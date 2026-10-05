<script setup lang="ts">
import { computed, ref } from 'vue'
import { useLinkageStore } from '../stores/linkage'
import { layoutGraph, type GraphNode } from '../lib/linkageGraph'

const store = useLinkageStore()
const selectedNode = ref<string | null>(null)

const layout = computed(() => layoutGraph(store.devices, store.rules.filter((r) => r.enabled)))

const deviceMap = computed(() => new Map(store.devices.map((d) => [d.id, d])))
const ruleMap = computed(() => new Map(store.rules.map((r) => [r.id, r])))

const nodeW = 172
const nodeH = 54

const width = computed(() => Math.max(1100, 140 + layout.value.layerCount * 300))
const height = computed(() => Math.max(560, ...layout.value.nodes.map((n) => n.y + 120)))

function nodeById(id: string): GraphNode | undefined {
  return layout.value.nodes.find((n) => n.id === id)
}

// 同一动作被多条规则触发时，标注高优先级执行路径
function repRuleOf(nodeId: string) {
  const incoming = layout.value.edges.filter((e) => e.to === nodeId)
  if (incoming.length <= 1) return null
  const sorted = [...incoming].sort((a, b) => a.priority - b.priority || a.delay - b.delay || a.id.localeCompare(b.id))
  return ruleMap.value.get(sorted[0].id)
}

function edgePath(from: GraphNode, to: GraphNode, back: boolean): string {
  if (from.id === to.id) {
    const x = from.x + nodeW / 2
    return `M ${x} ${from.y} C ${x + 46} ${from.y - 30}, ${x + 46} ${from.y + 30}, ${x} ${from.y + nodeH}`
  }
  if (back) {
    const x1 = from.x + nodeW / 2
    const x2 = to.x + nodeW / 2
    const y1 = from.y + nodeH
    const y2 = to.y + nodeH
    return `M ${x1} ${y1} C ${x1} ${y1 + 56}, ${x2} ${y2 + 56}, ${x2} ${y2}`
  }
  const x1 = from.x + nodeW
  const y1 = from.y + nodeH / 2
  const x2 = to.x
  const y2 = to.y + nodeH / 2
  const dx = Math.max(40, (x2 - x1) / 2)
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`
}

const selectedRules = computed(() => {
  if (!selectedNode.value) return []
  return layout.value.edges.filter((e) => e.from === selectedNode.value || e.to === selectedNode.value).map((e) => ruleMap.value.get(e.id)!).filter(Boolean)
})
</script>

<template>
  <section class="page">
    <div class="page-head">
      <div><p class="eyebrow">DEPENDENCY GRAPH / 条件依赖</p><h1>触发、互锁与动作路径</h1><p class="muted">环路以红色回边标注；同一动作多路径时按优先级保留执行路径。</p></div>
      <v-chip variant="tonal" prepend-icon="mdi-alert-outline">{{ store.validations.length }} 个待确认路径</v-chip>
    </div>

    <div class="graph-wrap panel">
      <svg :viewBox="`0 0 ${width} ${height}`" preserveAspectRatio="xMidYMid meet">
        <defs>
          <marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#60777e" /></marker>
          <marker id="arrow-cycle" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#C0392B" /></marker>
        </defs>

        <g v-for="edge in layout.edges" :key="edge.id">
          <path
            :d="edgePath(nodeById(edge.from)!, nodeById(edge.to)!, edge.back)"
            fill="none"
            :class="['edge', { cycle: edge.cycle, back: edge.back }]"
            :marker-end="edge.cycle ? 'url(#arrow-cycle)' : 'url(#arrow)'"
          />
          <g v-if="!edge.back">
            <circle :cx="(nodeById(edge.from)!.x + nodeW + nodeById(edge.to)!.x) / 2" :cy="(nodeById(edge.from)!.y + nodeH / 2 + nodeById(edge.to)!.y + nodeH / 2) / 2" r="11" class="rule-node" />
            <text :x="(nodeById(edge.from)!.x + nodeW + nodeById(edge.to)!.x) / 2" :y="(nodeById(edge.from)!.y + nodeH / 2 + nodeById(edge.to)!.y + nodeH / 2) / 2 + 3" text-anchor="middle" class="rule-id">{{ edge.priority }}</text>
          </g>
        </g>

        <g v-for="node in layout.nodes" :key="node.id" @click="selectedNode = node.id" class="node-group">
          <rect
            :x="node.x"
            :y="node.y"
            :width="nodeW"
            :height="nodeH"
            rx="8"
            :class="['node', node.kind, { cyclic: layout.cyclicNodeIds.includes(node.id), selected: selectedNode === node.id }]"
          />
          <text :x="node.x + 14" :y="node.y + 22" class="node-title">{{ deviceMap.get(node.id)?.name ?? node.id }}</text>
          <text :x="node.x + 14" :y="node.y + 40" class="node-sub">{{ node.id }} · {{ deviceMap.get(node.id)?.zone }}</text>
          <g v-if="layout.cyclicNodeIds.includes(node.id)">
            <circle :cx="node.x + nodeW - 12" :cy="node.y + 12" r="10" fill="#C0392B" />
            <text :x="node.x + nodeW - 12" :y="node.y + 16" text-anchor="middle" fill="white" font-size="13" font-weight="800">!</text>
          </g>
          <g v-if="repRuleOf(node.id)">
            <rect :x="node.x + nodeW - 58" :y="node.y - 10" width="58" height="18" rx="9" class="rep-badge" />
            <text :x="node.x + nodeW - 29" :y="node.y + 3" text-anchor="middle" class="rep-text">优 {{ repRuleOf(node.id)?.priority }}</text>
          </g>
        </g>
      </svg>

      <div class="graph-side" v-if="selectedNode">
        <v-btn icon="mdi-close" size="small" variant="text" @click="selectedNode = null" />
        <strong>{{ deviceMap.get(selectedNode)?.name ?? selectedNode }}</strong>
        <div class="side-sub">{{ selectedNode }} · {{ deviceMap.get(selectedNode)?.zone }}</div>
        <div v-if="layout.cyclicNodeIds.includes(selectedNode)" class="side-cycle"><v-icon icon="mdi-alert-circle" color="error" size="small" /> 该设备参与联动环，联调时将被隔离</div>
        <div class="side-rules">
          <div v-for="rule in selectedRules" :key="rule.id" class="side-rule">
            <v-chip size="x-small" :color="rule.priority === 1 ? 'error' : rule.priority === 2 ? 'warning' : 'default'" variant="tonal">P{{ rule.priority }}</v-chip>
            <span>{{ rule.id }} · 延时 {{ rule.delay }}s</span>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.graph-wrap { position: relative; overflow: auto; }
svg { display: block; min-width: 900px; width: 100%; background: radial-gradient(circle, #d9dfe0 1px, transparent 1px); background-size: 22px 22px; }
.node { fill: white; stroke-width: 1.6; cursor: pointer; }
.node.trigger { stroke: #397a82; }
.node.action { stroke: #a64c35; }
.node.both { stroke: #6a5acd; }
.node.cyclic { stroke: #c0392b; stroke-width: 2.4; fill: #fdf0ee; }
.node.selected { stroke-width: 3; }
.node-title { fill: #253a42; font-size: 12px; font-weight: 700; pointer-events: none; }
.node-sub { fill: #718188; font-size: 10px; pointer-events: none; }
.edge { stroke: #60777e; stroke-width: 2; opacity: 0.7; fill: none; }
.edge.back { stroke: #c0392b; stroke-width: 2; stroke-dasharray: 7 5; opacity: 0.9; }
.edge.cycle { stroke: #c0392b; stroke-width: 2.4; opacity: 1; }
.rule-node { fill: white; stroke: #597177; stroke-width: 1.5; }
.rule-id { fill: #4f666d; font-size: 9px; font-weight: 800; }
.rep-badge { fill: #a64c35; }
.rep-text { fill: white; font-size: 10px; font-weight: 700; }
.graph-side { position: absolute; top: 18px; right: 18px; width: 280px; padding: 14px; border: 1px solid #dbe2e3; border-radius: 9px; background: rgba(255, 255, 255, 0.97); box-shadow: 0 8px 25px rgba(31, 54, 62, 0.12); }
.graph-side strong { display: block; margin: 5px 0 2px; }
.side-sub { color: #718087; font-size: 11px; margin-bottom: 8px; }
.side-cycle { display: flex; align-items: center; gap: 6px; color: #c0392b; font-size: 12px; margin-bottom: 8px; }
.side-rules { display: grid; gap: 6px; }
.side-rule { display: flex; align-items: center; gap: 8px; font-size: 12px; color: #49585e; }
</style>
