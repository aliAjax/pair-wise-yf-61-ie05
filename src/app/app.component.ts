import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Store } from '@ngrx/store';
import { ScrollingModule } from '@angular/cdk/scrolling';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { MatTableModule } from '@angular/material/table';
import { TranslocoPipe } from '@jsverse/transloco';
import {
  approveBatch,
  confirmGateway,
  createBatch,
  dismissNotice,
  pauseBatch,
  resumeBatch,
  rollbackBatch,
  telemetryTick,
  updateBatchManifest
} from './state/release.actions';
import {
  selectAudits,
  selectBatchAccounts,
  selectBatches,
  selectGatewayAccounts,
  selectGroups,
  selectNotices,
  selectOverview,
  selectRelease
} from './state/release.selectors';
import type { BatchAccountView } from './state/release.selectors';
import type { ReleaseBatch } from './state/release.models';

const STATUS_LABEL: Record<string, string> = {
  draft: '草稿', approved: '已审批', running: '发布中', paused: '已暂停', completed: '已完成', rolled_back: '已回滚',
  installed: '已确认', pending: '待确认', superseded: '已被后批顶走', failed: '失败'
};

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule, ScrollingModule, MatButtonModule, MatCardModule, MatChipsModule, MatFormFieldModule, MatInputModule, MatProgressBarModule, MatSelectModule, MatTableModule, TranslocoPipe],
  template: `
    <header class="hero">
      <div><span class="eyebrow">OTA CONTROL</span><h1>{{ 'title' | transloco }}</h1><p>{{ 'subtitle' | transloco }}</p></div>
      <mat-chip-set><mat-chip highlighted>逐台发布账</mat-chip><mat-chip>终态回执先到后到可判定</mat-chip><mat-chip>审计可追踪</mat-chip></mat-chip-set>
    </header>

    <main>
      <section class="notices" *ngIf="(notices$ | async)?.length">
        <article class="notice" *ngFor="let notice of notices$ | async">
          <div>
            <b>{{ notice.kind === 'rollback' ? '回滚下账' : notice.kind === 'confirm' ? '人工确认' : '终态回执' }}</b>
            <span>{{ notice.at | date:'MM-dd HH:mm:ss' }} · {{ notice.actor }}</span>
            <p>{{ notice.message }}</p>
          </div>
          <button mat-stroked-button (click)="dismiss(notice.id)">知道了</button>
        </article>
      </section>

      <section class="stats">
        <mat-card appearance="outlined"><span>批次数</span><strong>{{ (batches$ | async)?.length ?? 0 }}</strong></mat-card>
        <mat-card appearance="outlined"><span>在线 / 台账网关</span><strong>{{ (overview$ | async)?.online ?? 0 }}/{{ (overview$ | async)?.totalGateways ?? 0 }}</strong></mat-card>
        <mat-card appearance="outlined"><span>已确认归属</span><strong>{{ (overview$ | async)?.confirmed ?? 0 }}</strong></mat-card>
        <mat-card appearance="outlined"><span>已减账（后批顶走）</span><strong>{{ (overview$ | async)?.disputed ?? 0 }}</strong></mat-card>
      </section>

      <section class="grid">
        <mat-card appearance="outlined">
          <mat-card-header><mat-card-title>{{ 'newBatch' | transloco }}</mat-card-title></mat-card-header>
          <mat-card-content class="form-grid">
            <mat-form-field><mat-label>批次名称</mat-label><input matInput [(ngModel)]="draft.name"></mat-form-field>
            <mat-form-field><mat-label>目标版本</mat-label><input matInput [(ngModel)]="draft.firmware"></mat-form-field>
            <mat-form-field><mat-label>回滚版本</mat-label><input matInput [(ngModel)]="draft.rollbackVersion"></mat-form-field>
            <mat-form-field><mat-label>设备分组</mat-label><mat-select [(ngModel)]="draft.groupId"><mat-option *ngFor="let group of groups$ | async" [value]="group.id" [disabled]="!group.compatible">{{ group.name }} · {{ group.region }}</mat-option></mat-select></mat-form-field>
            <mat-form-field><mat-label>灰度比例 %</mat-label><input matInput type="number" [(ngModel)]="draft.rolloutPercent"></mat-form-field>
            <mat-form-field><mat-label>失败阈值 %</mat-label><input matInput type="number" [(ngModel)]="draft.failureThreshold"></mat-form-field>
            <button mat-flat-button color="primary" (click)="create()">创建兼容批次</button>
          </mat-card-content>
        </mat-card>

        <mat-card appearance="outlined" class="batch-panel">
          <mat-card-header><mat-card-title>{{ 'batches' | transloco }}</mat-card-title></mat-card-header>
          <mat-card-content>
            <cdk-virtual-scroll-viewport itemSize="218" class="viewport">
              <article class="batch" *cdkVirtualFor="let account of accounts$ | async">
                <div class="row">
                  <div><b>{{ account.batch.name }}</b><small>目标 {{ account.batch.firmware }} → 回滚 {{ account.batch.rollbackVersion }} · 灰度范围 {{ account.scopeTotal }} 台</small></div>
                  <mat-chip [color]="account.batch.status === 'paused' || account.batch.status === 'rolled_back' ? 'warn' : 'primary'" highlighted>{{ statusLabel(account.batch.status) }}</mat-chip>
                </div>
                <mat-progress-bar mode="determinate" [value]="account.progress"></mat-progress-bar>
                <div class="row">
                  <span><b>{{ account.installed }}</b> 台版本对得上 · 待确认 {{ account.pending }} · 失败 {{ account.failed }} · 已回滚 {{ account.rolledBack }}<ng-container *ngIf="account.historyInstalled"> · 历史累计 {{ account.historyInstalled }}（不参与对账）</ng-container></span>
                  <span>{{ account.progress }}%</span>
                </div>
                <div class="mismatch" *ngIf="account.mismatches.length">
                  <p>对不上（{{ account.mismatches.length }} 台，不计入已装）：</p>
                  <div class="mismatch-item" *ngFor="let item of account.mismatches">
                    <mat-chip [highlighted]="true" [color]="item.status === 'failed' ? 'warn' : 'accent'">{{ statusLabel(item.status) }}</mat-chip>
                    <span>{{ item.gatewayName }}</span>
                    <small>{{ item.reason }} · 当前 {{ item.currentVersion }}</small>
                  </div>
                </div>
                <div class="manifest">
                  <mat-form-field class="manifest-version" *ngIf="canEditManifest(account)"><mat-label>版本清单目标版本</mat-label><input matInput [(ngModel)]="manifestEdits[account.batch.id]"></mat-form-field>
                  <mat-form-field class="manifest-percent" *ngIf="canEditManifest(account)"><mat-label>灰度比例 %</mat-label><input matInput type="number" [(ngModel)]="percentEdits[account.batch.id]"></mat-form-field>
                  <button mat-stroked-button *ngIf="canEditManifest(account)" (click)="saveManifest(account)">保存清单（未确认重算/已对上保留）</button>
                </div>
                <div class="actions">
                  <button mat-stroked-button *ngIf="account.batch.status === 'draft'" (click)="approve(account.batch.id)">审批</button>
                  <button mat-stroked-button *ngIf="account.batch.status === 'approved'" (click)="resume(account.batch.id)">开始发布</button>
                  <button mat-stroked-button *ngIf="account.batch.status === 'running'" (click)="pause(account.batch.id)">暂停</button>
                  <button mat-stroked-button *ngIf="account.batch.status === 'paused'" (click)="resume(account.batch.id)">继续</button>
                  <button mat-flat-button color="warn" [disabled]="account.batch.status === 'completed' || account.batch.status === 'rolled_back'" (click)="rollback(account.batch.id)">紧急回滚至 {{ account.batch.rollbackVersion }}</button>
                </div>
              </article>
            </cdk-virtual-scroll-viewport>
          </mat-card-content>
        </mat-card>
      </section>

      <mat-card appearance="outlined">
        <mat-card-header><mat-card-title>逐台发布账（网关唯一当前版本）</mat-card-title></mat-card-header>
        <mat-card-content>
          <cdk-virtual-scroll-viewport itemSize="92" class="gateway-viewport">
            <article class="gateway" *cdkVirtualFor="let row of gatewayAccounts$ | async">
              <div class="gateway-head">
                <b>{{ row.gateway.name }}</b>
                <small>{{ row.groupName }}</small>
                <mat-chip [highlighted]="true" [color]="row.gateway.online ? 'primary' : 'warn'">{{ row.gateway.online ? '在线' : '离线' }}</mat-chip>
                <span class="version">当前版本 <b>{{ row.gateway.currentVersion }}</b></span>
                <span class="owner">归属：<b>{{ row.ownerBatchName ?? '未确认' }}</b></span>
              </div>
              <div class="gateway-posts">
                <ng-container *ngIf="row.posts.length; else noPosts">
                  <span class="post" *ngFor="let item of row.posts"><i [class]="'dot ' + item.post.status"></i>{{ item.batchName }} · {{ statusLabel(item.post.status) }}<small *ngIf="item.post.at"> · {{ item.post.at | date:'MM-dd HH:mm:ss' }} · {{ item.post.actor }}</small></span>
                </ng-container>
                <ng-template #noPosts><small>尚无批次将其纳入灰度范围</small></ng-template>
              </div>
              <div class="gateway-actions" *ngIf="row.gateway.online">
                <ng-container *ngFor="let b of row.confirmableBatches">
                  <button mat-stroked-button color="primary" (click)="confirm(row.gateway.id, b.id, 'installed', '值长')">值长确认 {{ b.firmware }}</button>
                  <button mat-stroked-button color="warn" (click)="confirm(row.gateway.id, b.id, 'failed', '运维')">运维报失败（{{ b.name }}）</button>
                </ng-container>
              </div>
            </article>
          </cdk-virtual-scroll-viewport>
        </mat-card-content>
      </mat-card>

      <mat-card appearance="outlined">
        <mat-card-header><mat-card-title>{{ 'audit' | transloco }}</mat-card-title></mat-card-header>
        <mat-card-content class="audit-list"><div class="audit" *ngFor="let item of audits$ | async"><span>{{ item.at | date:'MM-dd HH:mm:ss' }}</span><b>{{ item.actor }}</b><p>{{ item.message }}</p></div></mat-card-content>
      </mat-card>
    </main>
  `,
  styles: [`
    :host { display:block; min-height:100vh; background:#edf4f5; }
    .hero { padding:36px max(24px,6vw) 28px; color:#fff; background:linear-gradient(125deg,#053b46,#0f6f6c 62%,#2a9d8f); display:flex; justify-content:space-between; gap:24px; align-items:end; }
    .hero h1 { margin:8px 0; font-size:clamp(30px,4vw,52px); letter-spacing:-.04em; } .hero p { margin:0; opacity:.8 } .eyebrow { letter-spacing:.2em; font-size:12px; opacity:.7 }
    main { padding:22px max(18px,5vw) 60px; display:grid; gap:20px; } .stats { display:grid; grid-template-columns:repeat(4,1fr); gap:16px; } .stats span { display:block;color:#607d86 } .stats strong { font-size:30px }
    .grid { display:grid; grid-template-columns:minmax(300px,.8fr) minmax(420px,1.2fr); gap:20px; } .form-grid { display:grid; grid-template-columns:1fr 1fr; gap:12px; padding-top:16px }
    .viewport { height:560px; } .gateway-viewport { height:460px }
    .batch { min-height:200px; border-bottom:1px solid #dde7e8; padding:12px 4px; display:grid; gap:10px }
    .row { display:flex;justify-content:space-between;gap:12px;align-items:center } small { display:block;color:#71858c } .actions { display:flex;gap:8px;flex-wrap:wrap }
    .mismatch { background:#fff7f3; border:1px solid #f3d3c2; border-radius:8px; padding:8px 10px; display:grid; gap:6px } .mismatch p { margin:0; font-weight:600; color:#a14b2a }
    .mismatch-item { display:flex; align-items:center; gap:8px } .mismatch-item small { margin-left:auto; text-align:right; max-width:46% }
    .manifest { display:flex; gap:8px; align-items:center; flex-wrap:wrap } .manifest-version { width:150px } .manifest-percent { width:110px } .manifest .mat-mdc-form-field { margin-bottom:-1.25em }
    .gateway { border-bottom:1px solid #e5ecee; padding:10px 4px; display:grid; gap:6px; min-height:76px }
    .gateway-head { display:flex; align-items:center; gap:10px } .gateway-head small { display:inline } .version { color:#33565e } .owner { color:#33565e; margin-left:auto }
    .gateway-posts { display:flex; gap:14px; flex-wrap:wrap } .post { font-size:13px; color:#33565e; display:inline-flex; align-items:center; gap:5px } .post small { display:inline }
    .dot { width:9px; height:9px; border-radius:50%; display:inline-block } .dot.installed { background:#2a9d8f } .dot.pending { background:#b8c4c7 } .dot.superseded { background:#e76f51 } .dot.rolled_back { background:#8d99ae } .dot.failed { background:#d62828 }
    .gateway-actions { display:flex; gap:8px; flex-wrap:wrap }
    .notices { display:grid; gap:10px; position:sticky; top:0; z-index:5 }
    .notice { display:flex; justify-content:space-between; gap:16px; align-items:center; background:#fff8e1; border:1px solid #e9c46a; border-radius:10px; padding:10px 14px; box-shadow:0 4px 14px rgba(0,0,0,.08) }
    .notice span { margin-left:10px; color:#8a6d1f; font-size:12px } .notice p { margin:4px 0 0 }
    .audit-list { max-height:320px; overflow:auto } .audit { display:grid;grid-template-columns:150px 110px 1fr;border-bottom:1px solid #e5ecee;padding:10px 4px } .audit p { margin:0 }
    @media(max-width:900px){ .hero{align-items:flex-start;flex-direction:column}.stats{grid-template-columns:1fr 1fr}.grid{grid-template-columns:1fr}.form-grid{grid-template-columns:1fr}.audit{grid-template-columns:1fr}.viewport{height:440px} }
  `]
})
export class AppComponent implements OnInit, OnDestroy {
  private readonly store = inject(Store);
  readonly groups$ = this.store.select(selectGroups);
  readonly batches$ = this.store.select(selectBatches);
  readonly accounts$ = this.store.select(selectBatchAccounts);
  readonly gatewayAccounts$ = this.store.select(selectGatewayAccounts);
  readonly audits$ = this.store.select(selectAudits);
  readonly notices$ = this.store.select(selectNotices);
  readonly overview$ = this.store.select(selectOverview);
  private timer?: number;
  readonly manifestEdits: Record<string, string> = {};
  readonly percentEdits: Record<string, number> = {};
  private dismissedTimers = new Set<string>();
  draft = { name: '', firmware: '3.0.0', rollbackVersion: '2.9.2', groupId: 'g-edge', rolloutPercent: 10, failureThreshold: 3 };

  ngOnInit() {
    this.timer = window.setInterval(() => this.store.dispatch(telemetryTick()), 1400);
    // 整棵发布账（schema v2）落 localStorage；reducer 负责旧 v1 数据迁移
    this.store.select(selectRelease).subscribe((state) => {
      if (typeof localStorage !== 'undefined') localStorage.setItem('firmware-release-v2', JSON.stringify(state));
      for (const notice of state.notices) {
        if (this.dismissedTimers.has(notice.id)) continue;
        this.dismissedTimers.add(notice.id);
        window.setTimeout(() => this.store.dispatch(dismissNotice({ id: notice.id })), 8000);
      }
    });
  }
  ngOnDestroy() { if (this.timer) window.clearInterval(this.timer); }

  statusLabel(status: string): string { return STATUS_LABEL[status] ?? status; }
  canEditManifest(account: BatchAccountView): boolean { return account.batch.status === 'draft' || account.batch.status === 'approved'; }

  create() {
    if (!this.draft.name || !this.draft.firmware || !this.draft.groupId) return;
    const batch: ReleaseBatch = { ...this.draft, id: crypto.randomUUID(), status: 'draft', updatedAt: new Date().toISOString(), historyInstalled: 0 };
    this.store.dispatch(createBatch({ batch }));
    this.draft = { ...this.draft, name: '' };
  }
  approve(id: string) { this.store.dispatch(approveBatch({ id, actor: '发布负责人' })); }
  pause(id: string) { this.store.dispatch(pauseBatch({ id, actor: '值班人员' })); }
  resume(id: string) { this.store.dispatch(resumeBatch({ id, actor: '运维人员' })); }
  rollback(id: string) { this.store.dispatch(rollbackBatch({ id, actor: '发布负责人' })); }
  dismiss(id: string) { this.store.dispatch(dismissNotice({ id })); }
  confirm(gatewayId: string, batchId: string, result: 'installed' | 'failed', actor: string) {
    this.store.dispatch(confirmGateway({ gatewayId, batchId, result, actor }));
  }
  saveManifest(account: BatchAccountView) {
    const firmware = this.manifestEdits[account.batch.id] ?? account.batch.firmware;
    const percent = Number(this.percentEdits[account.batch.id] ?? account.batch.rolloutPercent);
    if (!Number.isFinite(percent)) return;
    this.store.dispatch(updateBatchManifest({ id: account.batch.id, firmware, rolloutPercent: percent, actor: '发布负责人' }));
    delete this.manifestEdits[account.batch.id];
    delete this.percentEdits[account.batch.id];
  }
}
