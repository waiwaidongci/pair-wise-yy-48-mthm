<script setup lang="ts">
import { computed } from 'vue'
import { useQuery } from '@vue/apollo-composable'
import { LINKAGE_QUERY } from '../api/apollo'
import { useLinkageStore } from '../stores/linkage'

const store = useLinkageStore()
const { result } = useQuery(LINKAGE_QUERY)
const errorCount = computed(() => store.validations.filter((item) => item.severity === '错误').length)
const warningCount = computed(() => store.validations.filter((item) => item.severity === '警告').length)
const detectorTypes = ['感烟探测器', '感温探测器', '手动报警按钮', '输入模块']
const triggerCount = computed(() => store.devices.filter((device) => detectorTypes.includes(device.type)).length)
const coveredCount = computed(() => store.devices.filter((device) => detectorTypes.includes(device.type) && store.rules.some((rule) => rule.triggerId === device.id && rule.enabled)).length)
</script>

<template>
  <section class="page">
    <div class="page-head">
      <div>
        <p class="eyebrow">FIRE LINKAGE / 消防联动</p>
        <h1>{{ result?.project?.name ?? '消防联动配置项目' }}</h1>
        <p class="muted">{{ result?.project?.building ?? '1号楼 / 2号楼' }} · 设计依据 {{ result?.project?.standard ?? 'GB 50116-2013' }}</p>
      </div>
      <div class="actions">
        <v-btn variant="outlined" prepend-icon="mdi-export-variant">导出配置</v-btn>
        <v-btn color="primary" prepend-icon="mdi-script-text-play-outline" @click="$router.push('/commissioning')">进入联调账</v-btn>
      </div>
    </div>

    <div class="metric-grid">
      <article><span>点位总数</span><strong>{{ store.devices.length }}</strong><small>覆盖 2 个楼层分区</small></article>
      <article><span>启用规则</span><strong>{{ store.rules.filter((rule) => rule.enabled).length }}</strong><small>{{ store.rules.length }} 条矩阵关系</small></article>
      <article><span>阻断错误</span><strong class="error">{{ errorCount }}</strong><small>成环、缺失和互锁矛盾</small></article>
      <article><span>审阅警告</span><strong class="warning">{{ warningCount }}</strong><small>跨区和重复关系</small></article>
    </div>

    <div class="overview-grid">
      <section class="panel">
        <div class="panel-head"><h3>矩阵完整性</h3><v-chip size="small" color="success" variant="tonal">已覆盖 {{ coveredCount }}/{{ triggerCount }} 报警源</v-chip></div>
        <div class="coverage-list">
          <div v-for="device in store.devices.filter((item) => detectorTypes.includes(item.type))" :key="device.id">
            <div><strong>{{ device.name }}</strong><small>{{ device.floor }} / {{ device.zone }} · {{ device.address }}</small></div>
            <v-chip size="small" :color="store.rules.some((rule) => rule.triggerId === device.id && rule.enabled) ? 'success' : 'error'" variant="tonal">
              {{ store.rules.filter((rule) => rule.triggerId === device.id && rule.enabled).length ? `${store.rules.filter((rule) => rule.triggerId === device.id && rule.enabled).length} 个动作` : '缺少动作' }}
            </v-chip>
          </div>
        </div>
      </section>
      <aside class="panel">
        <div class="panel-head"><h3>联调账状态</h3><span class="muted">R{{ store.revision }} · {{ store.commissionGraph.configHash.slice(0, 8) }}</span></div>
        <div class="ledger-status">
          <strong>{{ store.latestRun ? store.latestRun.id : '尚无运行快照' }}</strong>
          <v-chip size="small" :color="store.latestRunIsUsable ? 'success' : 'warning'" variant="tonal">
            {{ store.latestRunIsUsable ? '最新快照可审阅' : store.latestRun ? '快照需重排或恢复' : '等待开始联调' }}
          </v-chip>
          <p>开始前自动隔离成环、缺失设备和重复动作；规则变更后未完成运行作废，已完成回执继续留档。</p>
          <v-btn block color="secondary" variant="tonal" prepend-icon="mdi-play-outline" @click="$router.push('/commissioning')">打开可重放联调账</v-btn>
        </div>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
.metric-grid { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 12px; margin-bottom: 14px; }
.metric-grid article { padding: 16px; border: 1px solid #dde3e3; border-radius: 10px; background: white; }
.metric-grid span, .metric-grid small { display: block; color: #758187; font-size: 12px; }
.metric-grid strong { display: block; margin: 7px 0; color: #293e45; font-size: 28px; }
.metric-grid .error { color: #b23e2a; }
.metric-grid .warning { color: #bd7928; }
.overview-grid { display: grid; grid-template-columns: minmax(0,1fr) 330px; gap: 14px; }
.coverage-list { padding: 6px 16px 14px; }
.coverage-list > div { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 0; border-bottom: 1px solid #edf0f0; }
.coverage-list strong, .coverage-list small { display: block; }
.coverage-list small { margin-top: 4px; color: #7b878c; }
.ledger-status { display: grid; gap: 12px; padding: 20px; }
.ledger-status strong { font-size: 13px; word-break: break-all; }
.ledger-status p { margin: 0; color: #66757c; font-size: 12px; line-height: 1.6; }
@media (max-width: 1000px) { .overview-grid { grid-template-columns: 1fr; } }
@media (max-width: 680px) { .metric-grid { grid-template-columns: 1fr 1fr; } }
</style>
