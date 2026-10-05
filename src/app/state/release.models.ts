export type BatchStatus = 'draft' | 'approved' | 'running' | 'paused' | 'completed' | 'rolled_back';

/**
 * 逐台发布账中，单台网关针对单个批次的对账状态：
 * - pending: 网关在本批灰度范围内，尚未收到终态回执，期望版本跟随版本清单
 * - installed: 收到安装成功终态回执，且为该网关最后到达的终态，版本对得上
 * - superseded: 曾计入本批已装，但后到的终态回执把网关判给了另一个批次
 * - rolled_back: 收到回滚终态回执（网关当前版本已变为回滚版本）
 * - failed: 收到安装失败终态回执
 */
export type LedgerPostStatus = 'pending' | 'installed' | 'superseded' | 'rolled_back' | 'failed';

export interface DeviceGroup {
  id: string;
  name: string;
  region: string;
  count: number;
  compatible: boolean;
  offlineGateways: number;
}

export interface Gateway {
  id: string;
  groupId: string;
  name: string;
  online: boolean;
  /** 网关唯一的当前版本，以最后到达的终态回执为准 */
  currentVersion: string;
  /** 当前版本归属于哪个批次（该批 installed 账目的批次），未确认为 null */
  ownerBatchId: string | null;
  /** 该网关最后到达的终态回执序号：控制台到达顺序，最后到达者算数 */
  seq: number;
  updatedAt: string | null;
}

export interface LedgerPost {
  gatewayId: string;
  batchId: string;
  /** 确认时冻结的版本；pending 期间随版本清单重算 */
  expectedVersion: string;
  status: LedgerPostStatus;
  /** 终态回执到达序号，越大越晚到 */
  seq: number;
  at: string | null;
  actor: string | null;
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
  updatedAt: string;
  /** 旧数据升级时折算的累计已装数，仅展示，不参与对账 */
  historyInstalled: number;
}

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  message: string;
}

export type NoticeKind = 'receipt' | 'confirm' | 'rollback';

export interface OwnershipNotice {
  id: string;
  at: string;
  actor: string;
  kind: NoticeKind;
  gatewayId: string;
  gatewayName: string;
  fromBatchId: string | null;
  toBatchId: string | null;
  version: string;
  message: string;
}

export interface ReleaseState {
  schema: 2;
  groups: DeviceGroup[];
  gateways: Gateway[];
  batches: ReleaseBatch[];
  posts: LedgerPost[];
  notices: OwnershipNotice[];
  audits: AuditEntry[];
  /** 终态回执全局递增序号，决定到达先后 */
  seq: number;
}
