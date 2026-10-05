import { createAction, props } from '@ngrx/store';
import type { ReleaseBatch } from './release.models';

export const createBatch = createAction('[Release] Create batch', props<{ batch: ReleaseBatch }>());
export const approveBatch = createAction('[Release] Approve batch', props<{ id: string; actor: string }>());
export const pauseBatch = createAction('[Release] Pause batch', props<{ id: string; actor: string }>());
export const resumeBatch = createAction('[Release] Resume batch', props<{ id: string; actor: string }>());
export const rollbackBatch = createAction('[Release] Rollback batch', props<{ id: string; actor: string }>());
export const telemetryTick = createAction('[Release] Telemetry tick');

/** 网关终态回执：按最后到达的回执更新当前版本 */
export const gatewayReceipt = createAction('[Release] Gateway receipt', props<{ gatewayId: string; batchId: string; result: 'success' | 'failed' }>());

/** 网关确认：值长/运维提交，后到的看到归属 */
export const confirmGateway = createAction('[Release] Confirm gateway', props<{ gatewayId: string; batchId: string; actor: string }>());

/** 版本清单改动：没确认的网关重算，已经对上的保留 */
export const updateBatchFirmware = createAction('[Release] Update batch firmware', props<{ id: string; firmware: string }>());
