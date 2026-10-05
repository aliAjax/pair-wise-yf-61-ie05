import { createReducer, on } from '@ngrx/store';
import type { AuditEntry, DeviceGroup, GatewayRecord, HistoryEntry, ReleaseBatch, ReleaseState } from './release.models';
import {
  approveBatch,
  confirmGateway,
  createBatch,
  gatewayReceipt,
  pauseBatch,
  resumeBatch,
  rollbackBatch,
  telemetryTick,
  updateBatchFirmware
} from './release.actions';

const STORAGE_KEY = 'firmware-release-v2';
const LEGACY_KEY = 'firmware-release-v1';

const initialGroups: DeviceGroup[] = [
  { id: 'g-edge', name: '华东边缘网关', region: '华东', count: 680, compatible: true, offlineGateways: 4 },
  { id: 'g-plant', name: '工业采集终端', region: '华南', count: 1240, compatible: false, offlineGateways: 12 },
  { id: 'g-clinic', name: '远程诊疗终端', region: '新加坡', count: 310, compatible: true, offlineGateways: 2 }
];
const now = new Date().toISOString();
const initialBatches: ReleaseBatch[] = [
  { id: 'batch-demo', name: '边缘网关安全补丁 2.8.1', firmware: '2.8.1', rollbackVersion: '2.7.9', groupId: 'g-edge', rolloutPercent: 20, failureThreshold: 3, status: 'approved', progress: 0, downloaded: 0, failed: 0, updatedAt: now }
];
const initialAudits: AuditEntry[] = [{ id: 'audit-1', at: now, actor: '运维值班', message: '批次 batch-demo 完成兼容性检查并进入已审批' }];

/** 为某个分组物化前 upTo 台网关（已存在的保留） */
function buildGatewaysForGroup(group: DeviceGroup, upTo: number, existing: GatewayRecord[]): GatewayRecord[] {
  const byId = new Map(existing.map((item) => [item.id, item]));
  const out = [...existing];
  for (let i = 0; i < upTo; i++) {
    const id = `${group.id}-${String(i).padStart(4, '0')}`;
    if (byId.has(id)) continue;
    out.push({
      id,
      name: `${group.name} ${String(i + 1).padStart(4, '0')}`,
      groupId: group.id,
      index: i,
      currentVersion: null,
      previousVersion: null,
      receiptBatchId: null,
      receiptResult: null,
      receiptAt: null,
      receiptedBatchIds: [],
      confirmedBy: null,
      confirmedAt: null,
      confirmedBatchId: null
    });
  }
  return out;
}

function fallbackState(): ReleaseState {
  const demo = initialBatches[0];
  const group = initialGroups.find((item) => item.id === demo.groupId)!;
  const target = Math.round(group.count * demo.rolloutPercent / 100);
  return {
    version: 2,
    groups: initialGroups,
    batches: initialBatches,
    gateways: buildGatewaysForGroup(group, target, []),
    history: [],
    audits: initialAudits
  };
}

/** 旧数据升级：v1 的累计已装数折成历史记录，不参与对账 */
function migrate(): ReleaseState {
  if (typeof localStorage === 'undefined') return fallbackState();
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) return JSON.parse(raw) as ReleaseState;
  const legacyRaw = localStorage.getItem(LEGACY_KEY);
  if (!legacyRaw) return fallbackState();
  const legacy = JSON.parse(legacyRaw) as Omit<ReleaseState, 'version' | 'gateways' | 'history'>;
  const history: HistoryEntry[] = legacy.batches.map((batch) => ({
    id: crypto.randomUUID(),
    batchId: batch.id,
    batchName: batch.name,
    kind: 'legacy_installed',
    installed: batch.downloaded,
    at: batch.updatedAt,
    note: '旧版本累计已装台数结转，不参与对账'
  }));
  return { version: 2, groups: legacy.groups, batches: legacy.batches, gateways: [], history, audits: legacy.audits };
}

const initialState = migrate();

function audit(state: ReleaseState, actor: string, message: string): AuditEntry[] {
  return [{ id: crypto.randomUUID(), at: new Date().toISOString(), actor, message }, ...state.audits];
}

/** 应用一条终态回执：成功则更新当前版本（最后到达的算数），并记录上一版本供回滚 */
function applyReceipt(gateway: GatewayRecord, batch: ReleaseBatch, result: 'success' | 'failed', at: string): GatewayRecord {
  const receiptedBatchIds = gateway.receiptedBatchIds.includes(batch.id)
    ? gateway.receiptedBatchIds
    : [...gateway.receiptedBatchIds, batch.id];
  if (result === 'success') {
    return {
      ...gateway,
      currentVersion: batch.firmware,
      previousVersion: gateway.currentVersion,
      receiptBatchId: batch.id,
      receiptResult: 'success',
      receiptAt: at,
      receiptedBatchIds,
      confirmedBy: '系统',
      confirmedAt: at,
      confirmedBatchId: batch.id
    };
  }
  return {
    ...gateway,
    receiptBatchId: batch.id,
    receiptResult: 'failed',
    receiptAt: at,
    receiptedBatchIds
  };
}

export const releaseReducer = createReducer(
  initialState,
  on(createBatch, (state, { batch }) => {
    const group = state.groups.find((item) => item.id === batch.groupId);
    const target = group ? Math.round(group.count * batch.rolloutPercent / 100) : 0;
    const gateways = group ? buildGatewaysForGroup(group, target, state.gateways) : state.gateways;
    return { ...state, batches: [batch, ...state.batches], gateways, audits: audit(state, '发布负责人', `创建批次 ${batch.name}，覆盖 ${target} 台`) };
  }),
  on(approveBatch, (state, { id, actor }) => ({ ...state, batches: state.batches.map((batch) => batch.id === id ? { ...batch, status: 'approved', updatedAt: new Date().toISOString() } : batch), audits: audit(state, actor, `批次 ${id} 审批通过`) })),
  on(pauseBatch, (state, { id, actor }) => ({ ...state, batches: state.batches.map((batch) => batch.id === id ? { ...batch, status: 'paused', updatedAt: new Date().toISOString() } : batch), audits: audit(state, actor, `批次 ${id} 已暂停`) })),
  on(resumeBatch, (state, { id, actor }) => ({ ...state, batches: state.batches.map((batch) => batch.id === id ? { ...batch, status: 'running', updatedAt: new Date().toISOString() } : batch), audits: audit(state, actor, `批次 ${id} 恢复发布`) })),
  on(rollbackBatch, (state, { id, actor }) => {
    const batch = state.batches.find((item) => item.id === id);
    let restored = 0;
    const gateways = state.gateways.map((gateway) => {
      if (gateway.receiptBatchId !== id || gateway.receiptResult !== 'success') return gateway;
      restored += 1;
      return {
        ...gateway,
        currentVersion: gateway.previousVersion,
        previousVersion: null,
        receiptBatchId: null,
        receiptResult: null,
        receiptAt: null,
        confirmedBy: null,
        confirmedAt: null,
        confirmedBatchId: null
      };
    });
    const at = new Date().toISOString();
    const history: HistoryEntry[] = batch
      ? [{ id: crypto.randomUUID(), batchId: id, batchName: batch.name, kind: 'rollback', installed: restored, at, note: `回滚 ${restored} 台至上一版本` }, ...state.history]
      : state.history;
    return {
      ...state,
      batches: state.batches.map((item) => item.id === id ? { ...item, status: 'rolled_back', updatedAt: at } : item),
      gateways,
      history,
      audits: audit(state, actor, `批次 ${id} 已紧急回滚，${restored} 台恢复至上一版本`)
    };
  }),
  on(gatewayReceipt, (state, { gatewayId, batchId, result }) => {
    const gateway = state.gateways.find((item) => item.id === gatewayId);
    const batch = state.batches.find((item) => item.id === batchId);
    if (!gateway || !batch) return state;
    const at = new Date().toISOString();
    const gateways = state.gateways.map((item) => item.id === gatewayId ? applyReceipt(item, batch, result, at) : item);
    return { ...state, gateways };
  }),
  on(confirmGateway, (state, { gatewayId, batchId, actor }) => {
    const gateway = state.gateways.find((item) => item.id === gatewayId);
    if (!gateway) return state;
    const batch = state.batches.find((item) => item.id === batchId);
    const alreadyConfirmedBy = gateway.confirmedBy;
    const at = new Date().toISOString();
    const gateways = state.gateways.map((item) => item.id === gatewayId
      ? { ...item, confirmedBy: actor, confirmedAt: at, confirmedBatchId: batchId }
      : item);
    let audits = state.audits;
    if (alreadyConfirmedBy && alreadyConfirmedBy !== actor) {
      audits = audit({ ...state, audits }, actor, `网关 ${gatewayId} 已由 ${alreadyConfirmedBy} 确认（归属 ${alreadyConfirmedBy}），${actor} 后到确认，归属更新为 ${actor}`);
    } else {
      audits = audit({ ...state, audits }, actor, `确认网关 ${gatewayId} 归属批次 ${batch?.name ?? batchId}`);
    }
    return { ...state, gateways, audits };
  }),
  on(updateBatchFirmware, (state, { id, firmware }) => {
    const batch = state.batches.find((item) => item.id === id);
    if (!batch) return state;
    const at = new Date().toISOString();
    const gateways = state.gateways.map((gateway) => {
      if (gateway.groupId !== batch.groupId) return gateway;
      // 已经对上的保留：已确认且装上的不动
      const confirmed = gateway.confirmedBatchId === batch.id && gateway.receiptResult === 'success';
      if (confirmed) return gateway;
      // 没确认的网关重算：清回执与确认，等新版本重新回执
      return {
        ...gateway,
        receiptBatchId: null,
        receiptResult: null,
        receiptAt: null,
        receiptedBatchIds: gateway.receiptedBatchIds.includes(batch.id)
          ? gateway.receiptedBatchIds.filter((item) => item !== batch.id)
          : gateway.receiptedBatchIds,
        confirmedBy: null,
        confirmedAt: null,
        confirmedBatchId: null
      };
    });
    const history: HistoryEntry[] = [
      { id: crypto.randomUUID(), batchId: id, batchName: batch.name, kind: 'firmware_change', installed: 0, at, note: `版本清单变更为 ${firmware}，未确认网关重算` },
      ...state.history
    ];
    return {
      ...state,
      batches: state.batches.map((item) => item.id === id ? { ...item, firmware, updatedAt: at } : item),
      gateways,
      history,
      audits: audit(state, '发布负责人', `批次 ${batch.name} 版本清单变更为 ${firmware}，未确认网关已重算`)
    };
  }),
  on(telemetryTick, (state) => {
    let gateways = [...state.gateways];
    const at = new Date().toISOString();
    // 按批次创建顺序处理，后创建的批次回执后到，最后到达的算数
    const runningBatches = state.batches.filter((batch) => batch.status === 'running');
    for (const batch of runningBatches) {
      const group = state.groups.find((item) => item.id === batch.groupId);
      if (!group) continue;
      const target = Math.round(group.count * batch.rolloutPercent / 100);
      const increment = Math.max(4, Math.round(target * 0.055));
      const candidates = gateways
        .filter((item) => item.groupId === group.id && item.index < target && !item.receiptedBatchIds.includes(batch.id))
        .sort((a, b) => a.index - b.index);
      for (const gateway of candidates.slice(0, increment)) {
        const result = Math.random() < 0.08 ? 'failed' as const : 'success' as const;
        const index = gateways.findIndex((item) => item.id === gateway.id);
        if (index >= 0) gateways[index] = applyReceipt(gateways[index], batch, result, at);
      }
    }
    const batches = state.batches.map((batch) => {
      if (batch.status !== 'running') return batch;
      const group = state.groups.find((item) => item.id === batch.groupId);
      const target = group ? Math.round(group.count * batch.rolloutPercent / 100) : 0;
      const receipted = gateways.filter((item) => item.groupId === group?.id && item.receiptedBatchIds.includes(batch.id)).length;
      const failed = gateways.filter((item) => item.groupId === group?.id && item.receiptBatchId === batch.id && item.receiptResult === 'failed').length;
      const downloaded = Math.min(target, receipted);
      const failureRate = downloaded ? failed / downloaded * 100 : 0;
      const status: ReleaseBatch['status'] = failureRate > batch.failureThreshold
        ? 'paused'
        : downloaded >= target ? 'completed' : 'running';
      return { ...batch, downloaded, failed, progress: target ? Math.round(downloaded / target * 100) : 0, status, updatedAt: at };
    });
    const overflow = batches.some((batch, index) => batch.status === 'paused' && state.batches[index]?.status === 'running');
    return { ...state, batches, gateways, audits: overflow ? audit(state, '系统', '失败率超过阈值，已自动暂停发布') : state.audits };
  })
);
