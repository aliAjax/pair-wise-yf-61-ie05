import { createFeatureSelector, createSelector } from '@ngrx/store';
import { scopeGatewayIds } from './release.reducer';
import type { Gateway, LedgerPost, ReleaseBatch, ReleaseState } from './release.models';

export const selectRelease = createFeatureSelector<ReleaseState>('release');
export const selectGroups = createSelector(selectRelease, (state) => state.groups);
export const selectGateways = createSelector(selectRelease, (state) => state.gateways);
export const selectBatches = createSelector(selectRelease, (state) => state.batches);
export const selectPosts = createSelector(selectRelease, (state) => state.posts);
export const selectAudits = createSelector(selectRelease, (state) => state.audits);
export const selectNotices = createSelector(selectRelease, (state) => state.notices);
export const selectSeq = createSelector(selectRelease, (state) => state.seq);

export interface MismatchEntry {
  gatewayId: string;
  gatewayName: string;
  status: LedgerPost['status'];
  expectedVersion: string;
  currentVersion: string;
  ownerBatchId: string | null;
  reason: string;
}

export interface BatchAccountView {
  batch: ReleaseBatch;
  scopeTotal: number;
  /** 只统计版本对得上（installed 且当前版本 == 本批目标版本）的已装台数 */
  installed: number;
  failed: number;
  rolledBack: number;
  pending: number;
  progress: number;
  failureRate: number;
  /** 旧数据升级折算的累计已装，仅展示，不参与对账 */
  historyInstalled: number;
  /** 对不上的逐台列出：被后批顶走、回滚、失败，以及装了但版本已不是目标版本 */
  mismatches: MismatchEntry[];
}

function mismatchReason(post: LedgerPost, gateway: Gateway, batch: ReleaseBatch): string {
  switch (post.status) {
    case 'superseded':
      return '后到终态已改挂其他批次，已装台数已减';
    case 'rolled_back':
      return `已回滚到 ${batch.rollbackVersion}`;
    case 'failed':
      return '终态回执：安装失败';
    case 'installed':
      return `当前版本 ${gateway.currentVersion} 与目标版本 ${batch.firmware} 不一致`;
    default:
      return '版本不匹配';
  }
}

export function buildBatchAccountView(state: ReleaseState, batch: ReleaseBatch): BatchAccountView {
  const scope = scopeGatewayIds(state.gateways, batch);
  const gatewayById = new Map(state.gateways.map((g) => [g.id, g]));
  const inScope = state.posts.filter((p) => p.batchId === batch.id && scope.has(p.gatewayId));

  let installed = 0;
  let failed = 0;
  let rolledBack = 0;
  let pending = 0;
  const mismatches: MismatchEntry[] = [];

  for (const post of inScope) {
    const gateway = gatewayById.get(post.gatewayId);
    if (!gateway) continue;
    // 版本对得上：终态 installed 且网关唯一当前版本仍是本批目标版本
    if (post.status === 'installed' && gateway.currentVersion === batch.firmware) {
      installed++;
    } else if (post.status === 'installed') {
      mismatches.push({ gatewayId: gateway.id, gatewayName: gateway.name, status: post.status, expectedVersion: post.expectedVersion, currentVersion: gateway.currentVersion, ownerBatchId: gateway.ownerBatchId, reason: mismatchReason(post, gateway, batch) });
    } else if (post.status === 'failed') {
      failed++;
      mismatches.push({ gatewayId: gateway.id, gatewayName: gateway.name, status: post.status, expectedVersion: post.expectedVersion, currentVersion: gateway.currentVersion, ownerBatchId: gateway.ownerBatchId, reason: mismatchReason(post, gateway, batch) });
    } else if (post.status === 'rolled_back') {
      rolledBack++;
      mismatches.push({ gatewayId: gateway.id, gatewayName: gateway.name, status: post.status, expectedVersion: post.expectedVersion, currentVersion: gateway.currentVersion, ownerBatchId: gateway.ownerBatchId, reason: mismatchReason(post, gateway, batch) });
    } else if (post.status === 'pending') {
      pending++;
    } else {
      // superseded：前一批已装台数被扣减的逐台记录
      mismatches.push({ gatewayId: gateway.id, gatewayName: gateway.name, status: post.status, expectedVersion: post.expectedVersion, currentVersion: gateway.currentVersion, ownerBatchId: gateway.ownerBatchId, reason: mismatchReason(post, gateway, batch) });
    }
  }

  const confirmed = installed + failed;
  return {
    batch,
    scopeTotal: scope.size,
    installed,
    failed,
    rolledBack,
    pending,
    progress: scope.size ? Math.round(installed / scope.size * 100) : 0,
    failureRate: confirmed ? failed / confirmed * 100 : 0,
    historyInstalled: batch.historyInstalled,
    mismatches
  };
}

export const selectBatchAccounts = createSelector(selectRelease, (state): BatchAccountView[] =>
  state.batches.map((batch) => buildBatchAccountView(state, batch))
);

export interface GatewayAccountView {
  gateway: Gateway;
  groupName: string;
  ownerBatchName: string | null;
  posts: Array<{ batchId: string; batchName: string; post: LedgerPost }>;
  /** 该网关还在哪些运行中/待发布批次的灰度范围内，可供值长/运维人工确认 */
  confirmableBatches: ReleaseBatch[];
}

export const selectGatewayAccounts = createSelector(selectRelease, (state): GatewayAccountView[] => {
  const groupById = new Map(state.groups.map((g) => [g.id, g]));
  const batchById = new Map(state.batches.map((b) => [b.id, b]));
  return state.gateways
    .map((gateway) => {
      const posts = state.posts
        .filter((p) => p.gatewayId === gateway.id)
        .map((p) => ({ batchId: p.batchId, batchName: batchById.get(p.batchId)?.name ?? p.batchId, post: p }))
        .sort((a, b) => b.post.seq - a.post.seq);
      const owner = gateway.ownerBatchId ? batchById.get(gateway.ownerBatchId) ?? null : null;
      const confirmableBatches = state.batches.filter((b) =>
        b.groupId === gateway.groupId &&
        (b.status === 'approved' || b.status === 'running' || b.status === 'paused') &&
        scopeGatewayIds(state.gateways, b).has(gateway.id)
      );
      return {
        gateway,
        groupName: groupById.get(gateway.groupId)?.name ?? gateway.groupId,
        ownerBatchName: owner ? owner.name : null,
        posts,
        confirmableBatches
      };
    })
    .sort((a, b) => b.gateway.seq - a.gateway.seq || a.gateway.id.localeCompare(b.gateway.id));
});

export const selectOverview = createSelector(selectRelease, (state) => {
  const totalGateways = state.gateways.length;
  const online = state.gateways.filter((g) => g.online).length;
  const confirmed = state.gateways.filter((g) => g.ownerBatchId !== null).length;
  const disputed = state.posts.filter((p) => p.status === 'superseded').length;
  return { totalGateways, online, confirmed, disputed };
});
