import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
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
import { approveBatch, confirmGateway, createBatch, pauseBatch, resumeBatch, rollbackBatch, telemetryTick, updateBatchFirmware } from './state/release.actions';
import { selectAudits, selectBatchStats, selectBatches, selectGateways, selectGroups, selectHistory, selectRelease, selectTotalInstalled } from './state/release.selectors';
import type { GatewayRecord, ReleaseBatch } from './state/release.models';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule, ScrollingModule, MatButtonModule, MatCardModule, MatChipsModule, MatFormFieldModule, MatInputModule, MatProgressBarModule, MatSelectModule, MatTableModule, TranslocoPipe],
  template: `
    <header class="hero">
      <div><span class="eyebrow">OTA CONTROL</span><h1>{{ 'title' | transloco }}</h1><p>{{ 'subtitle' | transloco }}</p></div>
      <mat-chip-set><mat-chip highlighted>逐台发布账</mat-chip><mat-chip>失败阈值自动暂停</mat-chip><mat-chip>回滚恢复上一版本</mat-chip></mat-chip-set>
    </header>

    <main>
      <section class="stats">
        <mat-card appearance="outlined"><span>批次数</span><strong>{{ (batches$ | async)?.length ?? 0 }}</strong></mat-card>
        <mat-card appearance="outlined"><span>兼容分组</span><strong>{{ (groups$ | async)?.length ?? 0 }}</strong></mat-card>
        <mat-card appearance="outlined"><span>已装台数（对账）</span><strong>{{ totalInstalled$ | async }}</strong></mat-card>
        <mat-card appearance="outlined"><span>审计记录</span><strong>{{ (audits$ | async)?.length ?? 0 }}</strong></mat-card>
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
            <cdk-virtual-scroll-viewport itemSize="176" class="viewport">
              <article class="batch" *cdkVirtualFor="let batch of batches$ | async; trackBy: trackBatch">
                <div class="row"><div><b>{{ batch.name }}</b><small>{{ batch.firmware }} → 回滚 {{ batch.rollbackVersion }}</small></div><mat-chip [color]="batch.status === 'paused' || batch.status === 'rolled_back' ? 'warn' : 'primary'" highlighted>{{ batch.status }}</mat-chip></div>
                <mat-progress-bar mode="determinate" [value]="batch.progress"></mat-progress-bar>
                <div class="row reconciled">
                  <span class="ok">已装 {{ stats[batch.id]?.installed ?? 0 }} 台</span>
                  <span class="mismatch" *ngIf="stats[batch.id]?.mismatched?.length">对不上 {{ stats[batch.id].mismatched.length }} 台</span>
                  <span>待回执 {{ stats[batch.id]?.pending ?? 0 }}</span>
                  <span>失败 {{ stats[batch.id]?.failed ?? 0 }}</span>
                </div>
                <div class="row"><span>已回执 {{ batch.downloaded }} · 阈值 {{ batch.failureThreshold }}%</span><span>{{ batch.progress }}%</span></div>
                <div class="mismatch-list" *ngIf="stats[batch.id]?.mismatched?.length">
                  <small>对不上：</small>
                  <mat-chip-set><mat-chip *ngFor="let gw of stats[batch.id].mismatched" highlighted>{{ gw.id }} → {{ gw.currentVersion }}</mat-chip></mat-chip-set>
                </div>
                <div class="history-line" *ngFor="let h of historyByBatch(batch.id)">
                  <small>{{ h.note }} · 结转 {{ h.installed }} 台（不参与对账）</small>
                </div>
                <div class="actions">
                  <button mat-stroked-button *ngIf="batch.status === 'draft'" (click)="approve(batch.id)">审批</button>
                  <button mat-stroked-button *ngIf="batch.status === 'approved'" (click)="resume(batch.id)">开始发布</button>
                  <button mat-stroked-button *ngIf="batch.status === 'running'" (click)="pause(batch.id)">暂停</button>
                  <button mat-stroked-button *ngIf="batch.status === 'paused'" (click)="resume(batch.id)">继续</button>
                  <button mat-flat-button color="warn" [disabled]="batch.status === 'completed' || batch.status === 'rolled_back'" (click)="rollback(batch.id)">紧急回滚</button>
                </div>
                <div class="firmware-edit" *ngIf="batch.status === 'draft' || batch.status === 'approved'">
                  <mat-form-field class="fw-input"><mat-label>版本清单</mat-label><input matInput [value]="batch.firmware" #fwInput></mat-form-field>
                  <button mat-stroked-button (click)="changeFirmware(batch.id, fwInput.value)">改动版本清单</button>
                </div>
              </article>
            </cdk-virtual-scroll-viewport>
          </mat-card-content>
        </mat-card>
      </section>

      <mat-card appearance="outlined">
        <mat-card-header><mat-card-title>网关逐台发布账</mat-card-title></mat-card-header>
        <mat-card-content>
          <cdk-virtual-scroll-viewport itemSize="56" class="gateway-viewport">
            <div class="gateway-row" *cdkVirtualFor="let gw of gateways$ | async; trackBy: trackGateway">
              <span class="gw-id">{{ gw.id }}</span>
              <span class="gw-ver">当前 <b>{{ gw.currentVersion ?? '—' }}</b></span>
              <span class="gw-prev" *ngIf="gw.previousVersion">上一版 {{ gw.previousVersion }}</span>
              <span class="gw-receipt" *ngIf="gw.receiptBatchId">回执 {{ gw.receiptResult }} · {{ gw.receiptBatchId }}</span>
              <span class="gw-owner" [class.unconfirmed]="!gw.confirmedBy">归属 {{ gw.confirmedBy ?? '未确认' }}</span>
              <span class="gw-actions">
                <button mat-stroked-button [disabled]="!gw.confirmedBatchId" (click)="confirm(gw.id, gw.confirmedBatchId ?? '', '值长')">值长确认</button>
                <button mat-stroked-button [disabled]="!gw.confirmedBatchId" (click)="confirm(gw.id, gw.confirmedBatchId ?? '', '运维')">运维确认</button>
              </span>
            </div>
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
    .viewport { height:620px; } .batch { min-height:168px; border-bottom:1px solid #dde7e8; padding:12px 4px; display:grid; gap:10px } .row { display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap } small { display:block;color:#71858c } .actions { display:flex;gap:8px;flex-wrap:wrap }
    .reconciled .ok { color:#2e7d32; font-weight:600 } .reconciled .mismatch { color:#c62828; font-weight:600 }
    .mismatch-list { display:flex; align-items:center; gap:8px; flex-wrap:wrap } .history-line { color:#8a6d3b }
    .firmware-edit { display:flex; align-items:center; gap:8px; } .fw-input { width:160px; }
    .gateway-viewport { height:360px; } .gateway-row { display:flex; align-items:center; gap:14px; padding:8px 4px; border-bottom:1px solid #e5ece; font-size:13px; flex-wrap:wrap }
    .gw-id { font-family:ui-monospace, monospace; font-weight:600; min-width:130px } .gw-ver b { color:#0f6f6c } .gw-prev { color:#71858c } .gw-receipt { color:#6a1b9a }
    .gw-owner { padding:2px 8px; border-radius:10px; background:#e0f2f1; color:#004d40 } .gw-owner.unconfirmed { background:#f5f5f5; color:#9e9e9e }
    .gw-actions { margin-left:auto; display:flex; gap:6px }
    .audit-list { max-height:320px; overflow:auto } .audit { display:grid;grid-template-columns:120px 110px 1fr;border-bottom:1px solid #e5ecee;padding:10px 4px } .audit p { margin:0 }
    @media(max-width:900px){ .hero{align-items:flex-start;flex-direction:column}.stats{grid-template-columns:1fr 1fr}.grid{grid-template-columns:1fr}.form-grid{grid-template-columns:1fr}.audit{grid-template-columns:1fr}.viewport{height:400px} }
  `]
})
export class AppComponent implements OnInit, OnDestroy {
  private readonly store = inject(Store);
  readonly groups$ = this.store.select(selectGroups);
  readonly batches$ = this.store.select(selectBatches);
  readonly audits$ = this.store.select(selectAudits);
  readonly gateways$ = this.store.select(selectGateways);
  readonly history$ = this.store.select(selectHistory);
  readonly totalInstalled$ = this.store.select(selectTotalInstalled);
  stats: Record<string, { installed: number; mismatched: GatewayRecord[]; pending: number; failed: number }> = {};
  private history: { batchId: string; note: string; installed: number }[] = [];
  private timer?: number;
  draft = { name: '', firmware: '3.0.0', rollbackVersion: '2.9.2', groupId: 'g-edge', rolloutPercent: 10, failureThreshold: 3 };

  ngOnInit() {
    this.timer = window.setInterval(() => this.store.dispatch(telemetryTick()), 1400);
    this.store.select(selectBatchStats).subscribe((stats) => this.stats = stats);
    this.store.select(selectHistory).subscribe((history) => this.history = history);
    this.store.select(selectRelease).subscribe((state) => localStorage.setItem('firmware-release-v2', JSON.stringify(state)));
  }
  ngOnDestroy() { if (this.timer) window.clearInterval(this.timer); }

  historyByBatch(batchId: string) { return this.history.filter((h) => h.batchId === batchId); }
  trackBatch(_index: number, batch: ReleaseBatch) { return batch.id; }
  trackGateway(_index: number, gateway: GatewayRecord) { return gateway.id; }

  create() {
    if (!this.draft.name || !this.draft.firmware || !this.draft.groupId) return;
    const batch: ReleaseBatch = { ...this.draft, id: crypto.randomUUID(), status: 'draft', progress: 0, downloaded: 0, failed: 0, updatedAt: new Date().toISOString() };
    this.store.dispatch(createBatch({ batch }));
    this.draft = { ...this.draft, name: '' };
  }
  approve(id: string) { this.store.dispatch(approveBatch({ id, actor: '发布负责人' })); }
  pause(id: string) { this.store.dispatch(pauseBatch({ id, actor: '值班人员' })); }
  resume(id: string) { this.store.dispatch(resumeBatch({ id, actor: '运维人员' })); }
  rollback(id: string) { this.store.dispatch(rollbackBatch({ id, actor: '发布负责人' })); }
  changeFirmware(id: string, firmware: string) {
    if (!firmware) return;
    this.store.dispatch(updateBatchFirmware({ id, firmware }));
  }
  confirm(gatewayId: string, batchId: string, actor: string) {
    if (!batchId) return;
    this.store.dispatch(confirmGateway({ gatewayId, batchId, actor }));
  }
}
