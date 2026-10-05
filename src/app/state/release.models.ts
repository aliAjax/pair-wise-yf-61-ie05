export type BatchStatus = 'draft' | 'approved' | 'running' | 'paused' | 'completed' | 'rolled_back';

export interface DeviceGroup {
  id: string;
  name: string;
  region: string;
  count: number;
  compatible: boolean;
  offlineGateways: number;
}

export interface ReleaseBatch {
  id: string;
  name: string;
  firmware: string;
  rollbackVersion: string;
  groupId: string;
  rolloutPercent: number;
  failureThreshold: number;
  status: BatchStatus;
  progress: number;
  downloaded: number;
  failed: number;
  updatedAt: string;
}

/** 逐台发布账：每台网关一条，只保留一个当前版本 */
export interface GatewayRecord {
  id: string;
  name: string;
  groupId: string;
  /** 组内序号，用于确定批次覆盖范围 */
  index: number;
  /** 当前版本（每台网关只留一个） */
  currentVersion: string | null;
  /** 上一版本，回滚时恢复 */
  previousVersion: string | null;
  /** 最后到达终态回执的批次 */
  receiptBatchId: string | null;
  receiptResult: 'success' | 'failed' | null;
  receiptAt: string | null;
  /** 已回执过的批次，避免同一批次重复回执 */
  receiptedBatchIds: string[];
  /** 归属确认 */
  confirmedBy: string | null;
  confirmedAt: string | null;
  confirmedBatchId: string | null;
}

/** 历史记录：旧数据结转等，不参与对账但批次里仍显示 */
export interface HistoryEntry {
  id: string;
  batchId: string;
  batchName: string;
  kind: 'legacy_installed' | 'rollback' | 'firmware_change' | 'manual';
  installed: number;
  at: string;
  note: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  message: string;
}

export interface ReleaseState {
  /** 状态结构版本，用于旧数据升级 */
  version: number;
  groups: DeviceGroup[];
  batches: ReleaseBatch[];
  /** 逐台发布账 */
  gateways: GatewayRecord[];
  /** 历史记录（不参与对账） */
  history: HistoryEntry[];
  audits: AuditEntry[];
}
