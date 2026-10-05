import { createAction, props } from '@ngrx/store';
import type { LedgerPostStatus, ReleaseBatch } from './release.models';

export const createBatch = createAction('[Release] Create batch', props<{ batch: ReleaseBatch }>());
export const approveBatch = createAction('[Release] Approve batch', props<{ id: string; actor: string }>());
export const pauseBatch = createAction('[Release] Pause batch', props<{ id: string; actor: string }>());
export const resumeBatch = createAction('[Release] Resume batch', props<{ id: string; actor: string }>());
/**
 * 回滚以批次登记的回滚版本为准（防止选错版本）：
 * 对当前归属本批的网关逐台下账，网关当前版本写为 rollbackVersion。
 */
export const rollbackBatch = createAction('[Release] Rollback batch', props<{ id: string; actor: string }>());

/**
 * 版本清单改动：只重算未确认（pending）的网关账目，
 * 已经对上的 installed 账目保留、期望版本冻结。
 */
export const updateBatchManifest = createAction(
  '[Release] Update batch manifest',
  props<{ id: string; firmware: string; rolloutPercent: number; actor: string }>()
);

/**
 * 网关上报终态回执。result 为终态，中间态（下载/重启中）不入账。
 * 两个批次都指向同一网关时，seq 最大（最后到达）的算数。
 */
export const gatewayReceipt = createAction(
  '[Release] Gateway terminal receipt',
  props<{ gatewayId: string; batchId: string; result: Extract<LedgerPostStatus, 'installed' | 'failed' | 'rolled_back'>; version?: string; actor?: string; at?: string }>()
);

/**
 * 人工确认（值长/运维），按最后到达处理：后提交的看到归属，
 * 先提交方若已被后来者顶掉，会在通知中看到归属变化。
 */
export const confirmGateway = createAction(
  '[Release] Confirm gateway',
  props<{ gatewayId: string; batchId: string; result: Extract<LedgerPostStatus, 'installed' | 'failed'>; actor: string }>()
);

export const dismissNotice = createAction('[Release] Dismiss notice', props<{ id: string }>());

export const telemetryTick = createAction('[Release] Telemetry tick');
