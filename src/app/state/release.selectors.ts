import { createFeatureSelector, createSelector } from '@ngrx/store';
import type { GatewayRecord, ReleaseState } from './release.models';

export const selectRelease = createFeatureSelector<ReleaseState>('release');
export const selectGroups = createSelector(selectRelease, (state) => state.groups);
export const selectBatches = createSelector(selectRelease, (state) => state.batches);
export const selectAudits = createSelector(selectRelease, (state) => state.audits);
export const selectGateways = createSelector(selectRelease, (state) => state.gateways);
export const selectHistory = createSelector(selectRelease, (state) => state.history);

export interface BatchStats {
  /** 版本对得上的已装台数 */
  installed: number;
  /** 对不上的网关（被别的批次刷过） */
  mismatched: GatewayRecord[];
  /** 待回执/没装上的网关 */
  pending: number;
  /** 本批失败台数 */
  failed: number;
}

/** 逐批对账：只统计版本对得上的，对不上的单独列出 */
export const selectBatchStats = createSelector(selectBatches, selectGateways, (batches, gateways): Record<string, BatchStats> => {
  const stats: Record<string, BatchStats> = {};
  for (const batch of batches) {
    const inGroup = gateways.filter((item) => item.groupId === batch.groupId);
    stats[batch.id] = {
      installed: inGroup.filter((item) => item.currentVersion === batch.firmware).length,
      mismatched: inGroup.filter((item) => item.currentVersion !== null && item.currentVersion !== batch.firmware),
      pending: inGroup.filter((item) => item.currentVersion === null).length,
      failed: inGroup.filter((item) => item.receiptBatchId === batch.id && item.receiptResult === 'failed').length
    };
  }
  return stats;
});

/** 已装台数合计（版本对得上的） */
export const selectTotalInstalled = createSelector(selectBatchStats, (stats) =>
  Object.values(stats).reduce((sum, item) => sum + item.installed, 0)
);
