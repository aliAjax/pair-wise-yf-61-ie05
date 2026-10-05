// 逐台发布账逻辑校验：直接以内存状态驱动 reducer（不触碰 localStorage）
import '@angular/compiler';
import assert from 'node:assert/strict';
import { releaseReducer, loadInitialState } from '../src/app/state/release.reducer.ts';
import * as actions from '../src/app/state/release.actions.ts';
import { buildBatchAccountView } from '../src/app/state/release.selectors.ts';
import type { ReleaseState } from '../src/app/state/release.models.ts';

const initial = releaseReducer(undefined, { type: '__init__' } as never);
const edgeGateways = initial.gateways.filter((g) => g.groupId === 'g-edge').sort((a, b) => a.id.localeCompare(b.id));
const [gw1, gw2, gw3] = edgeGateways;
const batchA = initial.batches.find((b) => b.id === 'batch-demo')!;      // 2.8.1, 20% -> 前6台
const batchB = initial.batches.find((b) => b.id === 'batch-demo-2')!;    // 2.8.2, 10% -> 前3台

let s: ReleaseState = initial;
const account = (id: string) => buildBatchAccountView(s, s.batches.find((b) => b.id === id)!);
const gateway = (id: string) => s.gateways.find((g) => g.id === id)!;
const post = (gw: string, b: string) => s.posts.find((p) => p.gatewayId === gw && p.batchId === b);

// 1. 初始：两个批次灰度范围重叠（前3台），全部 pending
assert.equal(account('batch-demo').scopeTotal, 6, 'A批范围6台');
assert.equal(account('batch-demo-2').scopeTotal, 3, 'B批范围3台');
assert.equal(account('batch-demo').pending, 6);

// 2. A 批先确认 gw1=2.8.1 -> A 已装 1
s = releaseReducer(s, actions.confirmGateway({ gatewayId: gw1.id, batchId: batchA.id, result: 'installed', actor: '值长' }));
assert.equal(account('batch-demo').installed, 1);
assert.equal(gateway(gw1.id).ownerBatchId, 'batch-demo');
assert.equal(gateway(gw1.id).currentVersion, '2.8.1');

// 3. B 批后确认同一台 gw1=2.8.2 -> 最后确认的算数：B 已装 +1，A 已装减 1（superseded）
s = releaseReducer(s, actions.confirmGateway({ gatewayId: gw1.id, batchId: batchB.id, result: 'installed', actor: '运维' }));
assert.equal(account('batch-demo-2').installed, 1, '后批确认计入B');
assert.equal(account('batch-demo').installed, 0, '前批已装台数减掉');
assert.equal(gateway(gw1.id).ownerBatchId, 'batch-demo-2');
assert.equal(gateway(gw1.id).currentVersion, '2.8.2', '网关只留一个当前版本');
assert.equal(post(gw1.id, 'batch-demo')?.status, 'superseded', '前批账目改挂 superseded');
assert.equal(account('batch-demo').mismatches.some((m) => m.gatewayId === gw1.id && m.status === 'superseded'), true, '对不上逐台列出');

// 4. 前一批的终态回执因网络延迟最后才到 -> 规则就是"最后到达的算数"，A 批反超，B 批减账
const seqBefore = s.seq;
s = releaseReducer(s, actions.gatewayReceipt({ gatewayId: gw1.id, batchId: batchA.id, result: 'installed', version: '2.8.1', actor: '网关上报' }));
assert.equal(gateway(gw1.id).ownerBatchId, 'batch-demo', '最后到达的终态算数');
assert.equal(gateway(gw1.id).currentVersion, '2.8.1', '网关唯一当前版本被最后回执改写');
assert.equal(s.seq, seqBefore + 1);
assert.equal(account('batch-demo').installed, 1);
assert.equal(account('batch-demo-2').installed, 0);
assert.equal(post(gw1.id, 'batch-demo-2')?.status, 'superseded', '后到的 A 批把 B 批顶走，B 已装减 1');

// 5. 版本清单改动：B 批目标版本改成 2.8.3
//    gw1 已对上（installed）保留不动；gw2/gw3 未确认 -> pending 期望版本重算
//    （先让 B 批回执最后到达，gw1 重新归 B 且为 installed）
s = releaseReducer(s, actions.gatewayReceipt({ gatewayId: gw1.id, batchId: batchB.id, result: 'installed', version: '2.8.2', actor: '网关上报' }));
assert.equal(post(gw1.id, 'batch-demo-2')?.status, 'installed');
s = releaseReducer(s, actions.updateBatchManifest({ id: batchB.id, firmware: '2.8.3', rolloutPercent: 10, actor: '发布负责人' }));
assert.equal(post(gw1.id, 'batch-demo-2')?.status, 'installed', '已对上的保留');
assert.equal(post(gw2.id, 'batch-demo-2')?.expectedVersion, '2.8.3', '未确认网关重算期望版本');
// 现在 gw1 当前 2.8.2 与 B 批清单 2.8.3 不一致 -> B 批不再把它算进已装，列入对不上
assert.equal(account('batch-demo-2').installed, 0, '清单改动后对不上不再计入');
assert.equal(account('batch-demo-2').mismatches.some((m) => m.gatewayId === gw1.id && m.currentVersion === '2.8.2'), true);

// 6. 灰度比例从 10%(3台) 调到 20%(6台)：新增 pending；再调回 10%：未确认的退出范围
s = releaseReducer(s, actions.updateBatchManifest({ id: batchB.id, firmware: '2.8.3', rolloutPercent: 20, actor: '发布负责人' }));
assert.equal(account('batch-demo-2').scopeTotal, 6);
assert.ok(post(edgeGateways[5].id, 'batch-demo-2'), '新进入范围的网关补 pending');
s = releaseReducer(s, actions.updateBatchManifest({ id: batchB.id, firmware: '2.8.3', rolloutPercent: 10, actor: '发布负责人' }));
assert.equal(account('batch-demo-2').scopeTotal, 3);
assert.equal(post(edgeGateways[5].id, 'batch-demo-2'), undefined, '退出范围的 pending 删除；已确认账目保留');
assert.ok(post(gw1.id, 'batch-demo-2'), '已确认的不因范围缩小丢失');

// 7. 值长与运维同时提交同一网关（gw2）：后到的看到归属，且产生归属通知
s = releaseReducer(s, actions.confirmGateway({ gatewayId: gw2.id, batchId: batchA.id, result: 'installed', actor: '值长' }));
s = releaseReducer(s, actions.confirmGateway({ gatewayId: gw2.id, batchId: batchB.id, result: 'installed', actor: '运维' }));
assert.equal(gateway(gw2.id).ownerBatchId, 'batch-demo-2');
const notice = s.notices.find((n) => n.gatewayId === gw2.id && n.toBatchId === 'batch-demo-2');
assert.ok(notice, '后到方看到归属变更通知');
assert.match(notice!.message, /已装台数减 1/);
assert.equal(account('batch-demo').mismatches.some((m) => m.gatewayId === gw2.id), true);
// 通知可关闭
s = releaseReducer(s, actions.dismissNotice({ id: notice!.id }));
assert.equal(s.notices.some((n) => n.id === notice!.id), false);

// 8. 紧急回滚：以批次登记的 rollbackVersion 逐台下账
s = releaseReducer(s, actions.resumeBatch({ id: batchB.id, actor: '运维人员' }));
s = releaseReducer(s, actions.rollbackBatch({ id: batchB.id, actor: '发布负责人' }));
assert.equal(gateway(gw2.id).currentVersion, '2.8.1', '回滚版本取批次登记值（B批 rollback=2.8.1）');
assert.equal(gateway(gw2.id).ownerBatchId, null, '回滚后归属清空');
assert.equal(post(gw2.id, 'batch-demo-2')?.status, 'rolled_back');
assert.equal(account('batch-demo-2').installed, 0);
assert.equal(s.batches.find((b) => b.id === 'batch-demo-2')?.status, 'rolled_back');
// gw1 当前是 2.8.2 也归属B -> 同样回滚
assert.equal(gateway(gw1.id).currentVersion, '2.8.1');

// 9. 失败终态：占序号、不抢版本归属
s = releaseReducer(s, actions.confirmGateway({ gatewayId: gw3.id, batchId: batchA.id, result: 'failed', actor: '运维' }));
assert.equal(gateway(gw3.id).ownerBatchId, null);
assert.equal(gateway(gw3.id).currentVersion, '2.7.9', '失败不改当前版本');
assert.equal(account('batch-demo').failed, 1);
// 失败之后再成功：重试可翻
s = releaseReducer(s, actions.gatewayReceipt({ gatewayId: gw3.id, batchId: batchA.id, result: 'installed', version: '2.8.1' }));
assert.equal(gateway(gw3.id).ownerBatchId, 'batch-demo');
assert.equal(account('batch-demo').installed, 1);

// 10. v1 旧数据迁移：downloaded 折成 historyInstalled，不产生账目、不参与对账
const legacy = {
  groups: initial.groups,
  batches: [{
    id: 'old-1', name: '旧批', firmware: '1.0.0', rollbackVersion: '0.9.0', groupId: 'g-edge',
    rolloutPercent: 50, failureThreshold: 5, status: 'running', progress: 80, downloaded: 123, failed: 7, updatedAt: new Date().toISOString()
  }],
  audits: []
};
globalThis.localStorage = {
  getItem: (k: string) => (k === 'firmware-release-v1' ? JSON.stringify(legacy) : null),
  setItem: () => {}, removeItem: () => {}, clear: () => {}
} as Storage;
const migrated = loadInitialState();
const oldBatch = migrated.batches.find((b) => b.id === 'old-1')!;
assert.equal(oldBatch.historyInstalled, 123, '累计已装折成历史记录');
assert.equal(migrated.posts.filter((p) => p.batchId === 'old-1').every((p) => p.status === 'pending'), true, '旧累计数不生成已装账目');
const oldAccount = buildBatchAccountView(migrated, oldBatch);
assert.equal(oldAccount.installed, 0, '历史记录不参与对账');
assert.equal(oldAccount.historyInstalled, 123);
assert.ok(migrated.audits.some((a) => a.message.includes('折算')), '迁移写入审计');

console.log('全部断言通过 ✔');
