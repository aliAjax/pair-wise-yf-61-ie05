import { createReducer, on } from '@ngrx/store';
import type {
  AuditEntry,
  DeviceGroup,
  Gateway,
  LedgerPost,
  NoticeKind,
  OwnershipNotice,
  ReleaseBatch,
  ReleaseState
} from './release.models';
import {
  approveBatch,
  confirmGateway,
  createBatch,
  dismissNotice,
  gatewayReceipt,
  pauseBatch,
  resumeBatch,
  rollbackBatch,
  telemetryTick,
  updateBatchManifest
} from './release.actions';

const STORAGE_KEY = 'firmware-release-v2';
const LEGACY_STORAGE_KEY = 'firmware-release-v1';
const GROUP_GATEWAY_CAP = 30;
const MAX_NOTICES = 30;

const initialGroups: DeviceGroup[] = [
  { id: 'g-edge', name: '华东边缘网关', region: '华东', count: 680, compatible: true, offlineGateways: 4 },
  { id: 'g-plant', name: '工业采集终端', region: '华南', count: 1240, compatible: false, offlineGateways: 12 },
  { id: 'g-clinic', name: '远程诊疗终端', region: '新加坡', count: 310, compatible: true, offlineGateways: 2 }
];

const BASELINE_VERSION: Record<string, string> = {
  'g-edge': '2.7.9',
  'g-plant': '3.1.0',
  'g-clinic': '1.4.2'
};

function seedGateways(groups: DeviceGroup[]): Gateway[] {
  return groups.flatMap((group) => {
    const total = Math.min(GROUP_GATEWAY_CAP, group.count);
    return Array.from({ length: total }, (_, index) => ({
      id: `${group.id}-gw-${String(index + 1).padStart(2, '0')}`,
      groupId: group.id,
      name: `${group.name}-${String(index + 1).padStart(2, '0')}`,
      online: index >= group.offlineGateways,
      currentVersion: BASELINE_VERSION[group.id] ?? 'unknown',
      ownerBatchId: null,
      seq: 0,
      updatedAt: null
    }));
  });
}

/** 灰度范围内的网关：组内按编号取前 ceil(n * percent / 100) 台 */
export function scopeSize(total: number, percent: number): number {
  const clamped = Math.min(100, Math.max(0, percent));
  return Math.ceil(total * clamped / 100);
}

export function scopeGatewayIds(gateways: Gateway[], batch: ReleaseBatch): Set<string> {
  const inGroup = gateways.filter((g) => g.groupId === batch.groupId).sort((a, b) => a.id.localeCompare(b.id));
  return new Set(inGroup.slice(0, scopeSize(inGroup.length, batch.rolloutPercent)).map((g) => g.id));
}

/**
 * 按版本清单维护 pending 账目：
 * 新进入灰度范围的网关补 pending；退出范围的 pending 删除（未确认，随时可重算）；
 * pending 的期望版本跟随清单；任何终态账目一律保留。
 */
function syncBatchPosts(posts: LedgerPost[], gateways: Gateway[], batch: ReleaseBatch): LedgerPost[] {
  const scope = scopeGatewayIds(gateways, batch);
  const kept = posts.filter((post) => {
    if (post.batchId !== batch.id) return true;
    if (post.status !== 'pending') return true;
    return scope.has(post.gatewayId);
  });
  const existing = new Set(kept.filter((p) => p.batchId === batch.id).map((p) => p.gatewayId));
  const additions: LedgerPost[] = [];
  for (const gatewayId of scope) {
    if (existing.has(gatewayId)) continue;
    additions.push({ gatewayId, batchId: batch.id, expectedVersion: batch.firmware, status: 'pending', seq: 0, at: null, actor: null });
  }
  const next = kept.map((post) =>
    post.batchId === batch.id && post.status === 'pending' ? { ...post, expectedVersion: batch.firmware } : post
  );
  return [...next, ...additions];
}

function buildSeedState(now: string): ReleaseState {
  const gateways = seedGateways(initialGroups);
  let batches: ReleaseBatch[] = [
    { id: 'batch-demo', name: '边缘网关安全补丁 2.8.1', firmware: '2.8.1', rollbackVersion: '2.7.9', groupId: 'g-edge', rolloutPercent: 20, failureThreshold: 5, status: 'approved', updatedAt: now, historyInstalled: 0 },
    { id: 'batch-demo-2', name: '边缘网关热修 2.8.2', firmware: '2.8.2', rollbackVersion: '2.8.1', groupId: 'g-edge', rolloutPercent: 10, failureThreshold: 5, status: 'approved', updatedAt: now, historyInstalled: 0 }
  ];
  let posts: LedgerPost[] = [];
  for (const batch of batches) posts = syncBatchPosts(posts, gateways, batch);
  const audits: AuditEntry[] = [{ id: crypto.randomUUID(), at: now, actor: '运维值班', message: '批次 batch-demo 完成兼容性检查并进入已审批' }];
  return { schema: 2, groups: initialGroups, gateways, batches, posts, notices: [], audits, seq: 0 };
}

/* ---------- 旧数据（v1：批次累计 downloaded）升级 ---------- */

interface LegacyBatch {
  id: string;
  name: string;
  firmware: string;
  rollbackVersion: string;
  groupId: string;
  rolloutPercent: number;
  failureThreshold: number;
  status: ReleaseBatch['status'];
  progress?: number;
  downloaded?: number;
  failed?: number;
  updatedAt: string;
}
interface LegacyState {
  groups: DeviceGroup[];
  batches: LegacyBatch[];
  audits: AuditEntry[];
}

function migrateLegacy(legacy: LegacyState, now: string): ReleaseState {
  const groups = legacy.groups ?? initialGroups;
  const gateways = seedGateways(groups);
  const batches: ReleaseBatch[] = (legacy.batches ?? []).map(({ downloaded, progress: _progress, failed: _failed, ...batch }) => ({
    ...batch,
    // 累计已装数折成历史记录：仅展示，不生成对账记录
    historyInstalled: downloaded ?? 0
  }));
  // 仍在发布链路中的批次按版本清单重建待确认账目；已完成/已回滚批次不重建
  let posts: LedgerPost[] = [];
  for (const batch of batches) {
    if (batch.status === 'draft' || batch.status === 'approved' || batch.status === 'running' || batch.status === 'paused') {
      posts = syncBatchPosts(posts, gateways, batch);
    }
  }
  const audits: AuditEntry[] = [
    { id: crypto.randomUUID(), at: now, actor: '系统', message: '旧版累计已装数已折算为批次历史记录，逐台发布账自本次升级起重新对账' },
    ...(legacy.audits ?? [])
  ];
  return { schema: 2, groups, gateways, batches, posts, notices: [], audits, seq: 0 };
}

export function loadInitialState(): ReleaseState {
  const now = new Date().toISOString();
  if (typeof localStorage === 'undefined') return buildSeedState(now);
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as ReleaseState | null;
    if (stored && stored.schema === 2 && Array.isArray(stored.gateways) && Array.isArray(stored.posts)) return stored;
    const legacy = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) ?? 'null') as LegacyState | null;
    if (legacy && Array.isArray(legacy.batches)) return migrateLegacy(legacy, now);
  } catch {
    // 落库损坏时回落到种子数据
  }
  return buildSeedState(now);
}

const initialState = loadInitialState();

function audit(state: ReleaseState, actor: string, message: string): AuditEntry[] {
  return [{ id: crypto.randomUUID(), at: new Date().toISOString(), actor, message }, ...state.audits];
}

/* ---------- 终态回执（网关上报 / 人工确认 / 回滚共用一条逐台账） ---------- */

type TerminalResult = 'installed' | 'failed' | 'rolled_back';

interface TerminalInput {
  gatewayId: string;
  batchId: string;
  result: TerminalResult;
  version?: string;
  actor: string;
  source: 'receipt' | 'confirm' | 'rollback';
  at: string;
}

function terminalVersion(input: TerminalInput, batch: ReleaseBatch): string {
  if (input.result === 'rolled_back') return batch.rollbackVersion;
  return input.version ?? batch.firmware;
}

function pushNotice(notices: OwnershipNotice[], notice: Omit<OwnershipNotice, 'id' | 'at'> & { at?: string }): OwnershipNotice[] {
  const entry: OwnershipNotice = { id: crypto.randomUUID(), at: notice.at ?? new Date().toISOString(), ...notice } as OwnershipNotice;
  return [entry, ...notices].slice(0, MAX_NOTICES);
}

function applyTerminal(state: ReleaseState, input: TerminalInput): ReleaseState {
  const gateway = state.gateways.find((g) => g.id === input.gatewayId);
  const batch = state.batches.find((b) => b.id === input.batchId);
  if (!gateway || !batch) return state;

  // 最后到达：全局递增 seq 即控制台到达顺序，最后到达的终态算数
  const seq = state.seq + 1;
  const otherBatchName = (id: string | null) => state.batches.find((b) => b.id === id)?.name ?? '—';

  let posts = state.posts;
  const postIndex = posts.findIndex((p) => p.gatewayId === gateway.id && p.batchId === batch.id);
  if (postIndex === -1) {
    posts = [...posts, { gatewayId: gateway.id, batchId: batch.id, expectedVersion: batch.firmware, status: 'pending', seq: 0, at: null, actor: null }];
  }
  const previousOwnerId = gateway.ownerBatchId;
  let ownerBatchId: string | null = previousOwnerId;
  let currentVersion = gateway.currentVersion;
  let kind: NoticeKind = input.source === 'rollback' ? 'rollback' : input.source === 'confirm' ? 'confirm' : 'receipt';
  let message = '';

  if (input.result === 'failed') {
    // 失败也是终态：占住该网关的最后终态序号，但不改变当前版本与归属
    posts = posts.map((p) =>
      p.gatewayId === gateway.id && p.batchId === batch.id
        ? { ...p, status: 'failed' as const, seq, at: input.at, actor: input.actor }
        : p
    );
  } else {
    const version = terminalVersion(input, batch);
    if (input.result === 'installed') {
      currentVersion = version;
      ownerBatchId = batch.id;
      // 后到的确认为准：前一批次的 installed 账目改挂 superseded，其已装台数自然减 1
      posts = posts.map((p) => {
        if (p.gatewayId !== gateway.id) return p;
        if (p.batchId === batch.id) {
          return { ...p, status: 'installed' as const, expectedVersion: version, seq, at: input.at, actor: input.actor };
        }
        if (p.status === 'installed') return { ...p, status: 'superseded' as const };
        return p;
      });
      if (previousOwnerId && previousOwnerId !== batch.id) {
        message = `网关 ${gateway.name} 后到的终态确认为 ${version}，已改挂批次「${batch.name}」；批次「${otherBatchName(previousOwnerId)}」已装台数减 1`;
      } else {
        message = `网关 ${gateway.name} 确认安装 ${version}，计入批次「${batch.name}」已装`;
      }
    } else {
      // rolled_back：以批次登记的回滚版本为准，网关当前版本改写，归属清空
      currentVersion = version;
      ownerBatchId = null;
      posts = posts.map((p) => {
        if (p.gatewayId !== gateway.id) return p;
        if (p.batchId === batch.id) return { ...p, status: 'rolled_back' as const, seq, at: input.at, actor: input.actor };
        if (p.status === 'installed') return { ...p, status: 'superseded' as const };
        return p;
      });
      message = `网关 ${gateway.name} 已按批次「${batch.name}」回滚到 ${version}，该批已装台数减 1`;
    }
  }

  const gateways = state.gateways.map((g) =>
    g.id === gateway.id ? { ...g, currentVersion, ownerBatchId, seq, updatedAt: input.at } : g
  );

  let audits = state.audits;
  if (input.source === 'confirm') {
    audits = audit(state, input.actor, input.result === 'failed'
      ? `人工确认网关 ${gateway.name} 在批次「${batch.name}」安装失败`
      : `人工确认网关 ${gateway.name} 安装 ${terminalVersion(input, batch)}（批次「${batch.name}」）`);
  } else if (input.result === 'installed' && previousOwnerId && previousOwnerId !== batch.id) {
    audits = audit(state, '系统', message);
  }

  const notices = input.result === 'failed' && input.source !== 'confirm'
    ? state.notices
    : pushNotice(state.notices, {
        at: input.at,
        actor: input.actor,
        kind,
        gatewayId: gateway.id,
        gatewayName: gateway.name,
        fromBatchId: previousOwnerId,
        toBatchId: ownerBatchId,
        version: currentVersion,
        message
      });

  return { ...state, seq, posts, gateways, notices, audits };
}

/* ---------- 批次对账统计（reducer 内部复用） ---------- */

function batchAccounts(state: ReleaseState, batch: ReleaseBatch) {
  const scope = scopeGatewayIds(state.gateways, batch);
  const inScopePosts = state.posts.filter((p) => p.batchId === batch.id && scope.has(p.gatewayId));
  const installed = inScopePosts.filter((p) => p.status === 'installed').length;
  const failed = inScopePosts.filter((p) => p.status === 'failed').length;
  const rolledBack = inScopePosts.filter((p) => p.status === 'rolled_back').length;
  const pending = inScopePosts.filter((p) => p.status === 'pending').length;
  const confirmed = installed + failed;
  const failureRate = confirmed ? failed / confirmed * 100 : 0;
  return { scope: scope.size, installed, failed, rolledBack, pending, confirmed, failureRate };
}

/* ---------- reducer ---------- */

export const releaseReducer = createReducer(
  initialState,
  on(createBatch, (state, { batch }) => {
    const batches = [batch, ...state.batches];
    const posts = syncBatchPosts(state.posts, state.gateways, batch);
    return { ...state, batches, posts, audits: audit(state, '发布负责人', `创建批次 ${batch.name}`) };
  }),
  on(approveBatch, (state, { id, actor }) => ({
    ...state,
    batches: state.batches.map((batch) => (batch.id === id ? { ...batch, status: 'approved', updatedAt: new Date().toISOString() } : batch)),
    audits: audit(state, actor, `批次 ${id} 审批通过`)
  })),
  on(pauseBatch, (state, { id, actor }) => ({
    ...state,
    batches: state.batches.map((batch) => (batch.id === id ? { ...batch, status: 'paused', updatedAt: new Date().toISOString() } : batch)),
    audits: audit(state, actor, `批次 ${id} 已暂停`)
  })),
  on(resumeBatch, (state, { id, actor }) => ({
    ...state,
    batches: state.batches.map((batch) => (batch.id === id ? { ...batch, status: 'running', updatedAt: new Date().toISOString() } : batch)),
    audits: audit(state, actor, `批次 ${id} 恢复发布`)
  })),
  on(updateBatchManifest, (state, { id, firmware, rolloutPercent, actor }) => {
    const previous = state.batches.find((b) => b.id === id);
    if (!previous) return state;
    const updated: ReleaseBatch = {
      ...previous,
      firmware: firmware.trim() || previous.firmware,
      rolloutPercent: Math.min(100, Math.max(0, rolloutPercent)),
      updatedAt: new Date().toISOString()
    };
    const batches = state.batches.map((b) => (b.id === id ? updated : b));
    // 版本清单改动：只重算 pending（期望版本 + 灰度范围），已对上的 installed 等终态账目保留
    const posts = syncBatchPosts(state.posts, state.gateways, updated);
    const changeNote = previous.firmware !== updated.firmware ? `，目标版本 ${previous.firmware} → ${updated.firmware}` : '';
    return { ...state, batches, posts, audits: audit(state, actor, `批次「${updated.name}」版本清单变更${changeNote}；未确认网关已重算，已确认账目保留`) };
  }),
  on(rollbackBatch, (state, { id, actor }) => {
    const batch = state.batches.find((b) => b.id === id);
    if (!batch) return state;
    const at = new Date().toISOString();
    // 回滚版本只取批次登记的 rollbackVersion，逐台下账，不靠网关自报版本
    const owned = state.gateways.filter((g) => g.ownerBatchId === batch.id);
    let next: ReleaseState = {
      ...state,
      batches: state.batches.map((b) => (b.id === id ? { ...b, status: 'rolled_back', updatedAt: at } : b)),
      // 批次终止：未确认的 pending 账目清掉，终态账目留档
      posts: state.posts.filter((p) => p.batchId !== id || p.status !== 'pending'),
      audits: audit(state, actor, `批次 ${id} 按登记回滚版本 ${batch.rollbackVersion} 紧急回滚，逐台下账 ${owned.length} 台`)
    };
    for (const gateway of owned) {
      next = applyTerminal(next, { gatewayId: gateway.id, batchId: id, result: 'rolled_back', actor, source: 'rollback', at });
    }
    return next;
  }),
  on(gatewayReceipt, (state, { gatewayId, batchId, result, version, actor, at }) =>
    applyTerminal(state, { gatewayId, batchId, result, version, actor: actor ?? '网关上报', source: 'receipt', at: at ?? new Date().toISOString() })
  ),
  on(confirmGateway, (state, { gatewayId, batchId, result, actor }) =>
    applyTerminal(state, { gatewayId, batchId, result, actor, source: 'confirm', at: new Date().toISOString() })
  ),
  on(dismissNotice, (state, { id }) => ({ ...state, notices: state.notices.filter((n) => n.id !== id) })),
  on(telemetryTick, (state) => {
    // 模拟在线网关按灰度范围上报终态回执；跨批次打乱顺序，后到的回执决定归属
    type PendingReceipt = { gatewayId: string; batchId: ReleaseBatch };
    const receipts: PendingReceipt[] = [];
    for (const batch of state.batches) {
      if (batch.status !== 'running') continue;
      const scope = scopeGatewayIds(state.gateways, batch);
      const pending = state.posts
        .filter((p) => p.batchId === batch.id && p.status === 'pending' && scope.has(p.gatewayId))
        .map((p) => state.gateways.find((g) => g.id === p.gatewayId)!)
        .filter((g) => g.online);
      const take = Math.min(pending.length, 1 + (Math.random() < 0.5 ? 1 : 0));
      for (let i = 0; i < take; i++) {
        const pick = pending.splice(Math.floor(Math.random() * pending.length), 1)[0];
        if (pick) receipts.push({ gatewayId: pick.id, batchId: batch });
      }
    }
    for (let i = receipts.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [receipts[i], receipts[j]] = [receipts[j], receipts[i]];
    }

    let next = state;
    for (const receipt of receipts) {
      const result = Math.random() < 0.1 ? 'failed' as const : 'installed' as const;
      next = applyTerminal(next, { gatewayId: receipt.gatewayId, batchId: receipt.batchId.id, result, actor: '网关上报', source: 'receipt', at: new Date().toISOString() });
    }

    // 批次状态按逐台对账结果重算：只统计版本对得上的 installed；
    // 被后批顶走/已回滚视为已结清，避免网关改挂后原批次永远完不成
    let autoPaused = false;
    let completed = false;
    const batches = next.batches.map((batch) => {
      if (batch.status !== 'running') return batch;
      const accounts = batchAccounts(next, batch);
      const settled = accounts.installed + accounts.failed;
      if (settled > 0 && accounts.failureRate > batch.failureThreshold) {
        autoPaused = true;
        return { ...batch, status: 'paused' as const, updatedAt: new Date().toISOString() };
      }
      if (accounts.scope > 0 && accounts.pending === 0 && settled + accounts.rolledBack >= accounts.scope) {
        completed = true;
        return { ...batch, status: 'completed' as const, updatedAt: new Date().toISOString() };
      }
      return batch;
    });
    next = { ...next, batches };
    if (autoPaused) next = { ...next, audits: audit(next, '系统', '失败率超过阈值，已按逐台对账结果自动暂停发布') };
    if (completed) next = { ...next, audits: audit(next, '系统', '灰度范围内网关全部完成终态确认，批次自动完成') };
    return next;
  })
);
