// 额度工具单测：工作时段判断 / 摘要归一
import test from 'node:test';
import assert from 'node:assert/strict';
import { quotaWorkTimeActive, summarizeQuota, QuotaService, extractQuotaSignal } from '../lib/quota.mjs';

test('quotaWorkTimeActive：工作时段内/外判断', () => {
  const workTime = { timeZone: 'Asia/Shanghai', startTime: '08:30', endTime: '17:30' };
  // 2026-11-10 10:00 +08:00 = 02:00Z
  const inside = quotaWorkTimeActive(workTime, Date.parse('2026-11-10T02:00:00Z'));
  assert.deepEqual(inside, { known: true, active: true });
  // 2026-11-10 20:00 +08:00 = 12:00Z
  const outside = quotaWorkTimeActive(workTime, Date.parse('2026-11-10T12:00:00Z'));
  assert.deepEqual(outside, { known: true, active: false });
});

test('quotaWorkTimeActive：跨午夜与字段缺失', () => {
  const night = { timeZone: 'Asia/Shanghai', startTime: '22:00', endTime: '06:00' };
  assert.equal(quotaWorkTimeActive(night, Date.parse('2026-11-10T15:00:00Z')).active, true); // 23:00 +08
  assert.equal(quotaWorkTimeActive(night, Date.parse('2026-11-10T04:00:00Z')).active, false); // 12:00 +08
  assert.deepEqual(quotaWorkTimeActive(undefined), { known: false, active: true });
  assert.deepEqual(quotaWorkTimeActive({ timeZone: 'Asia/Shanghai' }), { known: false, active: true });
});

test('summarizeQuota：窗口与工作时段归一', () => {
  const snap = summarizeQuota({
    optResult: 0,
    data: {
      quotaStatus: 'ACTIVE',
      fiveHour: { usagePercent: 42, used: 42, limit: 100, resetAt: 1794300000000, thresholdPercent: 80 },
      sevenDay: { usagePercent: 100, used: 1000, limit: 1000, resetAt: 1794900000000 },
      quotaWorkTime: { timeZone: 'Asia/Shanghai', startTime: '08:30', endTime: '17:30' },
      canUpgrade: true,
    },
  });
  assert.equal(snap.quotaStatus, 'ACTIVE');
  assert.equal(snap.windows['5H'].usagePercent, 42);
  assert.equal(snap.windows['7D'].usagePercent, 100);
  assert.equal(snap.exhausted, true);
  assert.ok(snap.quotaWorkTime);
  assert.equal(snap.canUpgrade, true);
});

test('recordPassive：保留服务端 thresholdPercent/windowId/eventId', () => {
  const svc = new QuotaService({
    config: { quota: { assumeUnknownHeadroom: 0.5, probe: { hourlyBudget: 10 } } },
    logger: null,
  });
  const signal = extractQuotaSignal({
    data: {
      codefree: {
        notifications: [
          {
            type: 'QUOTA_WARNING',
            period: '5H',
            usagePercent: 85,
            resetAt: 1794300000000,
            eventId: 'evt-1',
            thresholdPercent: 70,
            windowId: 'win-1',
          },
        ],
      },
    },
  });
  assert.equal(signal.kind, 'warning');
  svc.recordPassive('acc-a', signal);
  const w = svc.get('acc-a').windows['5H'];
  assert.equal(w.usagePercent, 85);
  assert.equal(w.thresholdPercent, 70, '被动信号应保留服务端阈值');
  assert.equal(w.windowId, 'win-1');
  assert.equal(w.eventId, 'evt-1');
});

test('recordPassive：新窗口 warning 清除旧 EXHAUSTED 状态', () => {
  const svc = new QuotaService({
    config: { quota: { assumeUnknownHeadroom: 0.5, probe: { hourlyBudget: 10 } } },
    logger: null,
  });
  const r1 = Date.now() + 60_000;
  svc.recordPassive(
    'acc-a',
    extractQuotaSignal({ code: 'AI_QUOTA_EXHAUSTED', periods: ['5H'], used: 100, limit: 100, resetAt: r1 }),
  );
  assert.equal(svc.get('acc-a').windows['5H'].status, 'EXHAUSTED');
  assert.equal(svc.get('acc-a').exhausted, true);

  const r2 = r1 + 60_000;
  svc.recordPassive(
    'acc-a',
    extractQuotaSignal({
      data: {
        codefree: {
          notifications: [
            { type: 'QUOTA_WARNING', period: '5H', usagePercent: 85, resetAt: r2, eventId: 'e2', thresholdPercent: 80 },
          ],
        },
      },
    }),
  );
  const w = svc.get('acc-a').windows['5H'];
  assert.equal(w.status, 'ACTIVE', '新窗口 warning 不应保留旧 EXHAUSTED');
  assert.equal(w.usagePercent, 85);
  assert.equal(w.retryAt, undefined, '旧 retryAt 应被清除');
  assert.equal(svc.get('acc-a').exhausted, false);
});

test('recordProbe：缺失窗口不再沿用旧状态', () => {
  const svc = new QuotaService({
    config: { quota: { assumeUnknownHeadroom: 0.5, probe: { hourlyBudget: 10 } } },
    logger: null,
  });
  const resetAt = Date.now() + 60_000;
  svc.recordProbe(
    'acc-a',
    summarizeQuota({
      data: {
        quotaStatus: 'ACTIVE',
        fiveHour: { usagePercent: 100, used: 100, limit: 100, resetAt },
        sevenDay: { usagePercent: 50, used: 500, limit: 1000, resetAt },
      },
    }),
  );
  assert.ok(svc.get('acc-a').windows['5H']);
  assert.ok(svc.get('acc-a').windows['7D']);

  svc.recordProbe(
    'acc-a',
    summarizeQuota({
      data: { quotaStatus: 'ACTIVE', fiveHour: { usagePercent: 10, used: 10, limit: 100, resetAt } },
    }),
  );
  assert.ok(svc.get('acc-a').windows['5H']);
  assert.equal(svc.get('acc-a').windows['7D'], undefined, '探测响应缺失的窗口应被移除');
});
