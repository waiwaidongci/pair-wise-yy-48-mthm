import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import {
  buildCommissioningGraph,
  markRunSuperseded,
  resumeCommissioningRun,
  startCommissioningRun,
  type CommissionRun,
  type PreflightIssue,
} from '../linkage/commissioning'

export type DeviceType = '感烟探测器' | '感温探测器' | '手动报警按钮' | '输入模块' | '输出模块' | '排烟风机' | '排烟防火阀' | '防火卷帘' | '消防广播' | '电梯'
export type Device = { id: string; name: string; type: DeviceType; floor: string; zone: string; address: string }
export type Rule = {
  id: string
  triggerId: string
  actionId: string
  delay: number
  interlock: string
  priority: 1 | 2 | 3
  suppression: string
  enabled: boolean
}
export type Validation = {
  id: string
  code?: PreflightIssue['code']
  severity: '错误' | '警告'
  ruleIds: string[]
  title: string
  detail: string
  suggestion: string
}

export const seedDevices: Device[] = [
  { id: 'D-01-01', name: '一层大厅感烟 01', type: '感烟探测器', floor: '1F', zone: 'A 区', address: '1-A-01-01' },
  { id: 'D-01-02', name: '一层大厅感烟 02', type: '感烟探测器', floor: '1F', zone: 'A 区', address: '1-A-01-02' },
  { id: 'D-01-11', name: '一层东侧手报', type: '手动报警按钮', floor: '1F', zone: 'A 区', address: '1-A-02-01' },
  { id: 'D-02-01', name: '二层机房感温 01', type: '感温探测器', floor: '2F', zone: 'B 区', address: '2-B-01-01' },
  { id: 'D-02-02', name: '二层机房感烟 01', type: '感烟探测器', floor: '2F', zone: 'B 区', address: '2-B-01-02' },
  { id: 'A-01-01', name: '一层排烟风机 PF-1', type: '排烟风机', floor: '1F', zone: 'A 区', address: '1-F-01-01' },
  { id: 'A-01-02', name: '中庭防火卷帘 01', type: '防火卷帘', floor: '1F', zone: '中庭', address: '1-R-01-01' },
  { id: 'A-01-03', name: '一层消防广播', type: '消防广播', floor: '1F', zone: 'A 区', address: '1-B-01-01' },
  { id: 'A-01-04', name: '一层排烟防火阀 FD-1', type: '排烟防火阀', floor: '1F', zone: 'A 区', address: '1-V-01-01' },
  { id: 'A-01-05', name: '一层疏散输出模块 M-1', type: '输出模块', floor: '1F', zone: 'A 区', address: '1-M-01-01' },
  { id: 'A-01-06', name: '中庭防火卷帘 02', type: '防火卷帘', floor: '1F', zone: '中庭', address: '1-R-01-02' },
  { id: 'A-01-07', name: '一层排烟防火阀 FD-2', type: '排烟防火阀', floor: '1F', zone: 'A 区', address: '1-V-01-02' },
  { id: 'A-02-01', name: '二层排烟风机 PF-2', type: '排烟风机', floor: '2F', zone: 'B 区', address: '2-F-01-01' },
  { id: 'A-02-02', name: '1 号客梯归位', type: '电梯', floor: '2F', zone: 'B 区', address: '2-L-01-01' },
]

export const seedRules: Rule[] = [
  { id: 'R-001', triggerId: 'D-01-01', actionId: 'A-01-04', delay: 0, interlock: '无', priority: 1, suppression: '无', enabled: true },
  { id: 'R-002', triggerId: 'D-01-01', actionId: 'A-01-03', delay: 5, interlock: '无', priority: 2, suppression: '手动广播优先', enabled: true },
  { id: 'R-003', triggerId: 'D-01-02', actionId: 'A-01-06', delay: 0, interlock: '排烟风机运行', priority: 1, suppression: '无', enabled: true },
  { id: 'R-004', triggerId: 'D-01-11', actionId: 'A-01-03', delay: 3, interlock: '无', priority: 1, suppression: '无', enabled: true },
  { id: 'R-005', triggerId: 'D-02-01', actionId: 'A-02-01', delay: 0, interlock: '防火阀开启反馈', priority: 1, suppression: '无', enabled: true },
  { id: 'R-006', triggerId: 'D-02-01', actionId: 'A-02-02', delay: 10, interlock: '轿厢无人确认', priority: 2, suppression: '消防电梯模式', enabled: true },
  { id: 'R-007', triggerId: 'D-02-02', actionId: 'A-01-01', delay: 0, interlock: '无', priority: 3, suppression: '无', enabled: false },
  { id: 'R-008', triggerId: 'D-01-01', actionId: 'A-02-02', delay: 0, interlock: '无', priority: 1, suppression: '无', enabled: true },
  { id: 'R-009', triggerId: 'A-01-04', actionId: 'A-01-01', delay: 2, interlock: '防火阀全开反馈', priority: 1, suppression: '无', enabled: true },
  { id: 'R-010', triggerId: 'A-01-01', actionId: 'A-01-05', delay: 1, interlock: '风机运行反馈', priority: 1, suppression: '无', enabled: true },
  { id: 'R-011', triggerId: 'D-01-01', actionId: 'A-01-01', delay: 12, interlock: '无', priority: 3, suppression: '无', enabled: true },
  { id: 'R-012', triggerId: 'A-01-02', actionId: 'A-01-07', delay: 0, interlock: '卷帘下降反馈', priority: 1, suppression: '无', enabled: true },
  { id: 'R-013', triggerId: 'A-01-07', actionId: 'A-01-02', delay: 0, interlock: '阀门开启反馈', priority: 1, suppression: '无', enabled: true },
  { id: 'R-016', triggerId: 'A-01-06', actionId: 'A-01-07', delay: 0, interlock: '二组卷帘反馈', priority: 1, suppression: '无', enabled: true },
  { id: 'R-014', triggerId: 'D-01-01', actionId: 'A-99-99', delay: 0, interlock: '无', priority: 2, suppression: '无', enabled: true },
  { id: 'R-015', triggerId: 'D-01-01', actionId: 'A-01-04', delay: 4, interlock: '备用回路', priority: 2, suppression: '主回路运行', enabled: true },
]

function loadDraft() {
  try {
    const saved = localStorage.getItem('fire-linkage-draft-v2')
    return saved ? JSON.parse(saved) : null
  } catch {
    return null
  }
}

export const useLinkageStore = defineStore('linkage', () => {
  const restored = loadDraft()
  const devices = ref<Device[]>(restored?.devices ?? structuredClone(seedDevices))
  const rules = ref<Rule[]>(restored?.rules ?? structuredClone(seedRules))
  const revision = ref(restored?.revision ?? 17)
  const locked = ref(restored?.locked ?? false)
  const acceptedChanges = ref<string[]>(restored?.acceptedChanges ?? ['CH-01'])
  const commissioningRuns = ref<CommissionRun[]>(restored?.commissioningRuns ?? [])
  const latestRunId = ref<string | null>(restored?.latestRunId ?? null)
  const selectedRuleIds = ref<string[]>(restored?.selectedRuleIds ?? [])

  const commissionGraph = computed(() => buildCommissioningGraph(devices.value, rules.value))
  const businessValidations = computed<Validation[]>(() => {
    const result: Validation[] = []
    const triggers = devices.value.filter((device) => ['感烟探测器', '感温探测器', '手动报警按钮', '输入模块'].includes(device.type))
    for (const trigger of triggers) {
      const enabled = rules.value.filter((rule) => rule.triggerId === trigger.id && rule.enabled)
      if (enabled.length === 0) {
        result.push({ id: `missing-${trigger.id}`, severity: '错误', ruleIds: [], title: `${trigger.name} 缺少联动动作`, detail: '报警点未配置任何启用的因果规则。', suggestion: '至少配置广播、排烟或疏散相关动作。' })
      }
    }
    rules.value.filter((rule) => rule.enabled).forEach((rule) => {
      const trigger = devices.value.find((device) => device.id === rule.triggerId)
      const action = devices.value.find((device) => device.id === rule.actionId)
      if (trigger && action && trigger.zone !== action.zone && rule.suppression === '无') {
        result.push({ id: `cross-${rule.id}`, severity: '警告', ruleIds: [rule.id], title: `${rule.id} 跨区联动未配置抑制`, detail: `${trigger.zone} 报警将直接触发 ${action.zone} 动作。`, suggestion: '确认疏散边界并增加分区确认或抑制条件。' })
      }
      if (rule.interlock && rule.interlock !== '无' && rule.delay > 5 && rule.priority === 1) {
        result.push({ id: `contradiction-${rule.id}`, severity: '错误', ruleIds: [rule.id], title: `${rule.id} 互锁与高优先级延时冲突`, detail: '一级优先规则在互锁未明确反馈前延时超过 5 秒。', suggestion: '缩短延时或改为反馈后触发。' })
      }
    })
    return result
  })
  const graphValidations = computed<Validation[]>(() => commissionGraph.value.issues.map((issue) => ({ ...issue })))
  const validations = computed<Validation[]>(() => [...graphValidations.value, ...businessValidations.value])

  watch([devices, rules, revision, locked, acceptedChanges, commissioningRuns, latestRunId, selectedRuleIds], () => {
    localStorage.setItem('fire-linkage-draft-v2', JSON.stringify({
      devices: devices.value,
      rules: rules.value,
      revision: revision.value,
      locked: locked.value,
      acceptedChanges: acceptedChanges.value,
      commissioningRuns: commissioningRuns.value,
      latestRunId: latestRunId.value,
      selectedRuleIds: selectedRuleIds.value,
    }))
  }, { deep: true })

  function invalidateUnfinishedRuns() {
    commissioningRuns.value = commissioningRuns.value.map((run) => {
      if (run.configHash === commissionGraph.value.configHash || run.status !== 'paused') return run
      return markRunSuperseded(run)
    })
  }

  function touchConfiguration() {
    revision.value += 1
    invalidateUnfinishedRuns()
  }

  function updateRule(id: string, patch: Partial<Rule>) {
    if (locked.value) return
    const rule = rules.value.find((item) => item.id === id)
    if (!rule) return
    Object.assign(rule, patch)
    touchConfiguration()
  }

  function addRule() {
    if (locked.value) return
    rules.value.push({
      id: `R-${String(rules.value.length + 1).padStart(3, '0')}`,
      triggerId: devices.value[0]?.id ?? '',
      actionId: devices.value.at(-1)?.id ?? '',
      delay: 0,
      interlock: '无',
      priority: 2,
      suppression: '无',
      enabled: true,
    })
    touchConfiguration()
  }

  function batchUpdate(patch: Partial<Rule>) {
    if (locked.value || selectedRuleIds.value.length === 0) return
    rules.value = rules.value.map((rule) => (selectedRuleIds.value.includes(rule.id) ? { ...rule, ...patch } : rule))
    touchConfiguration()
  }

  function toggleSelected(enabled: boolean) {
    batchUpdate({ enabled })
  }

  function addDevice(device: Device) {
    if (locked.value) return
    devices.value.push(device)
    touchConfiguration()
  }

  function startRun(rootIds: string[], failDeviceId?: string) {
    const run = startCommissioningRun(devices.value, rules.value, revision.value, rootIds, failDeviceId)
    commissioningRuns.value.push(run)
    latestRunId.value = run.id
    return run
  }

  function resumeLatestRun() {
    const latest = latestRun.value
    if (!latest || latest.status !== 'paused' || latest.configHash !== commissionGraph.value.configHash) return null
    const resumed = resumeCommissioningRun(latest, devices.value, rules.value)
    const index = commissioningRuns.value.findIndex((run) => run.id === resumed.id)
    if (index >= 0) commissioningRuns.value[index] = resumed
    return resumed
  }

  function rerunLatest() {
    const latest = latestRun.value
    return startRun(latest?.rootIds.length ? latest.rootIds : commissionGraph.value.defaultRootIds)
  }

  const latestRun = computed(() => commissioningRuns.value.at(-1))
  const currentSnapshot = computed(() => latestRun.value?.configHash === commissionGraph.value.configHash ? latestRun.value : undefined)
  const latestRunIsUsable = computed(() => Boolean(currentSnapshot.value && currentSnapshot.value.status === 'completed' && graphValidations.value.filter((issue) => issue.severity === '错误').length === 0))

  function lockBaseline() {
    locked.value = true
    revision.value += 1
  }

  function unlock() {
    locked.value = false
  }

  return {
    devices,
    rules,
    revision,
    locked,
    acceptedChanges,
    selectedRuleIds,
    commissioningRuns,
    latestRunId,
    commissionGraph,
    validations,
    latestRun,
    currentSnapshot,
    latestRunIsUsable,
    updateRule,
    addRule,
    batchUpdate,
    toggleSelected,
    addDevice,
    startRun,
    resumeLatestRun,
    rerunLatest,
    lockBaseline,
    unlock,
  }
})
