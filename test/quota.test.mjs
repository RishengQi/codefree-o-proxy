// 额度工具单测：工作时段判断 / 摘要归一
import test from 'node:test';
import assert from 'node:assert/strict';
import { quotaWorkTimeActive, summarizeQuota } from '../lib/quota.mjs';

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
