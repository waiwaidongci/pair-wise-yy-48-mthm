<script setup lang="ts">
import { computed, ref } from 'vue'
import { buildCommissioningGraph } from '../linkage/commissioning'
import { useLinkageStore } from '../stores/linkage'

const store = useLinkageStore()
const checklist = ref([
  { done: true, title: '设备地址与竣工图一致', owner: '消防电专业' },
  { done: true, title: '所有报警点完成单点调试', owner: '调试组' },
  { done: false, title: '跨区联动完成现场确认', owner: '消防审阅人' },
  { done: false, title: '互锁反馈时长完成测试', owner: '暖通专业' },
  { done: false, title: '签字交付包完成哈希校验', owner: '项目负责人' },
])
const changes = [
  { id: 'CH-01', title: 'PF-1 前增加防火阀开启反馈互锁', source: '暖通专业', oldValue: '直接启动 PF-1', newValue: 'FD-1 开启后启动 PF-1', risk: '低' },
  { id: 'CH-02', title: '电梯归位延时由 0 秒调整至 10 秒', source: '电梯专业', oldValue: '延时：0s', newValue: '延时：10s', risk: '中' },
  { id: 'CH-03', title: '机房感烟联动 1F 排烟风机', source: '智能化专业', oldValue: '无关系', newValue: 'R-007 / 当前停用', risk: '高' },
]
const latestSnapshot = computed(() => store.latestRun)
const currentSnapshot = computed(() => store.currentSnapshot)
const snapshotGraph = computed(() => currentSnapshot.value ? buildCommissioningGraph(currentSnapshot.value.devices, currentSnapshot.value.rules) : store.commissionGraph)
const snapshotErrorCount = computed(() => snapshotGraph.value.issues.filter((issue) => issue.severity === '错误').length)
const snapshotUsable = computed(() => store.latestRunIsUsable)
const canLock = computed(() => snapshotUsable.value && checklist.value.every((item) => item.done))

function accept(id: string) {
  if (!store.acceptedChanges.includes(id)) store.acceptedChanges.push(id)
}

function snapshotReason() {
  if (!latestSnapshot.value) return '尚未运行联调账'
  if (latestSnapshot.value.status === 'superseded') return '最新运行已被规则变更作废'
  if (latestSnapshot.value.configHash !== store.commissionGraph.configHash) return '规则已变更，该快照不是当前版本'
  if (latestSnapshot.value.status !== 'completed') return '运行仍暂停，需恢复并跑完'
  if (snapshotErrorCount.value > 0) return '快照中仍有成环或缺失设备错误'
  return '快照可用于审阅'
}

function exportPackage() {
  const payload = JSON.stringify({
    revision: store.revision,
    configuration: {
      hash: store.commissionGraph.configHash,
      devices: store.devices,
      rules: store.rules,
    },
    latestSnapshot: currentSnapshot.value ?? null,
    validations: store.validations,
    acceptedChanges: store.acceptedChanges,
  }, null, 2)
  const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `消防联动交付包-R${store.revision}.json`
  link.click()
  URL.revokeObjectURL(url)
}
</script>

<template>
  <section class="page">
    <div class="page-head">
      <div><p class="eyebrow">REVIEW & SIGN-OFF / 审阅签字</p><h1>最新运行快照、版本差异与锁定</h1><p class="muted">版本审阅只采用最新且与当前规则哈希一致的联调运行；历史回执留档但不能用于签字。</p></div>
      <div class="actions"><v-btn variant="outlined" prepend-icon="mdi-download" @click="exportPackage">导出交付包</v-btn><v-btn v-if="!store.locked" color="primary" prepend-icon="mdi-lock-outline" :disabled="!canLock" @click="store.lockBaseline">签字锁定</v-btn><v-btn v-else color="warning" variant="outlined" @click="store.unlock">解锁修订</v-btn></div>
    </div>

    <v-alert v-if="!snapshotUsable && !store.locked" type="warning" variant="tonal" class="mb-3">当前不能签字：{{ snapshotReason() }}。请进入联调账完成预检、运行和恢复。</v-alert>
    <v-alert v-if="store.locked" type="success" variant="tonal" class="mb-3">当前版本 R{{ store.revision }} 已签字锁定；后续修改会生成新的规则版本和审阅快照。</v-alert>

    <section class="panel snapshot-panel mb-3">
      <div class="panel-head">
        <h3>唯一可审阅运行快照</h3>
        <v-chip size="small" :color="snapshotUsable ? 'success' : 'warning'" variant="tonal" prepend-icon="mdi-script-check-outline">{{ snapshotReason() }}</v-chip>
      </div>
      <div class="snapshot-grid">
        <article>
          <span>运行编号</span>
          <strong>{{ latestSnapshot?.id ?? '—' }}</strong>
          <small>创建时间：{{ latestSnapshot ? new Date(latestSnapshot.createdAt).toLocaleString() : '未创建' }}</small>
        </article>
        <article>
          <span>规则哈希</span>
          <strong class="mono">{{ store.commissionGraph.configHash.slice(0, 10) }}</strong>
          <small>{{ latestSnapshot?.configHash === store.commissionGraph.configHash ? '快照与当前规则一致' : '快照与当前规则不一致' }}</small>
        </article>
        <article>
          <span>动作回执</span>
          <strong>{{ latestSnapshot?.receipts.filter((receipt) => receipt.status === 'completed').length ?? 0 }} 完成</strong>
          <small>{{ latestSnapshot?.receipts.length ?? 0 }} 张原回执，完成记录不会重做</small>
        </article>
        <article>
          <span>预检状态</span>
          <strong :class="snapshotErrorCount ? 'error' : ''">{{ snapshotErrorCount }} 个错误</strong>
          <small>错误路径已隔离；签字仍要求错误清零</small>
        </article>
      </div>
      <div class="snapshot-actions">
        <v-btn variant="tonal" prepend-icon="mdi-script-text-play-outline" @click="$router.push('/commissioning')">进入联调账</v-btn>
        <v-btn v-if="latestSnapshot && !snapshotUsable" variant="tonal" color="warning" prepend-icon="mdi-refresh" @click="$router.push('/commissioning')">生成最新快照</v-btn>
      </div>
    </section>

    <div class="review-grid">
      <section class="panel">
        <div class="panel-head"><h3>矩阵校验结果</h3><v-chip size="small" color="error" variant="tonal">{{ store.validations.length }} 项</v-chip></div>
        <div class="validation-list">
          <article v-for="item in store.validations" :key="item.id" :class="item.severity">
            <v-icon :icon="item.severity === '错误' ? 'mdi-close-octagon-outline' : 'mdi-alert-outline'" />
            <div><strong>{{ item.title }}</strong><p>{{ item.detail }}</p><small>建议：{{ item.suggestion }}</small></div>
            <v-btn size="small" variant="text" @click="$router.push(item.code ? '/dependency' : '/matrix')">定位</v-btn>
          </article>
          <div v-if="store.validations.length === 0" class="empty-validation"><v-icon icon="mdi-check-decagram" size="38" color="success" /><strong>矩阵校验通过</strong><span>未发现遗漏、重复、矛盾、缺失或依赖闭环。</span></div>
        </div>
      </section>

      <aside>
        <section class="panel">
          <div class="panel-head"><h3>联调清单</h3><span class="muted">{{ checklist.filter((item) => item.done).length }}/{{ checklist.length }}</span></div>
          <div class="checklist">
            <v-checkbox v-for="item in checklist" :key="item.title" v-model="item.done" :label="item.title" :hint="item.owner" persistent-hint density="compact" />
          </div>
        </section>
      </aside>
    </div>

    <section class="panel change-panel">
      <div class="panel-head"><h3>专业提交版本差异</h3><span class="muted">可逐项接受</span></div>
      <v-table>
        <thead><tr><th>变更</th><th>来源</th><th>原始值</th><th>提交值</th><th>风险</th><th>决定</th></tr></thead>
        <tbody>
          <tr v-for="change in changes" :key="change.id">
            <td><strong>{{ change.id }}</strong><br />{{ change.title }}</td>
            <td>{{ change.source }}</td>
            <td class="old">{{ change.oldValue }}</td>
            <td class="new">{{ change.newValue }}</td>
            <td><v-chip size="small" :color="change.risk === '高' ? 'error' : change.risk === '中' ? 'warning' : 'success'" variant="tonal">{{ change.risk }}</v-chip></td>
            <td><v-btn v-if="!store.acceptedChanges.includes(change.id)" size="small" color="primary" variant="tonal" @click="accept(change.id)">接受变更</v-btn><v-chip v-else color="success" variant="tonal" prepend-icon="mdi-check">已接受</v-chip></td>
          </tr>
        </tbody>
      </v-table>
    </section>
  </section>
</template>

<style scoped>
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
.snapshot-panel { border-left: 4px solid #265e66; }
.snapshot-grid { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 10px; padding: 14px; }
.snapshot-grid article { padding: 13px; border: 1px solid #e2e7e8; border-radius: 9px; background: #fafbfb; }
.snapshot-grid span, .snapshot-grid small { display: block; color: #758187; font-size: 11px; }
.snapshot-grid strong { display: block; margin: 8px 0; color: #263c43; font-size: 14px; word-break: break-all; }
.snapshot-grid strong.error { color: #b23e2a; }
.mono { font-family: ui-monospace,monospace; }
.snapshot-actions { display: flex; gap: 8px; padding: 0 14px 15px; }
.review-grid { display: grid; grid-template-columns: minmax(0,1fr) 350px; gap: 14px; margin-bottom: 14px; }
.validation-list { padding: 8px 16px 16px; }
.validation-list article { display: grid; grid-template-columns: 28px 1fr auto; gap: 10px; padding: 13px 0; border-bottom: 1px solid #edf0f0; }
.validation-list article.error { color: #b13d2c; }
.validation-list article.warning { color: #b87b22; }
.validation-list strong { font-size: 13px; }
.validation-list p { margin: 5px 0; color: #59676d; font-size: 12px; line-height: 1.5; }
.validation-list small { color: #7f8b90; }
.empty-validation { display: grid; justify-items: center; gap: 7px; padding: 42px; color: #3d7b63; }
.empty-validation span { color: #748086; font-size: 12px; }
.checklist { padding: 10px 14px 16px; }
.change-panel { overflow-x: auto; }
.change-panel :deep(table) { min-width: 850px; }
.old { color: #a54b35; }
.new { color: #2e755e; font-weight: 700; }
@media (max-width: 1100px) { .review-grid, .snapshot-grid { grid-template-columns: 1fr 1fr; } }
@media (max-width: 760px) { .review-grid, .snapshot-grid { grid-template-columns: 1fr; } }
</style>
