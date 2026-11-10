// Prometheus 文本指标渲染（/metrics）
// 指标覆盖：账号健康/额度/用量、消费者限额、池级运行时状态。
import { quotaWorkTimeActive } from './quota.mjs';

function esc(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
}

function line(name, labels, value, help, type = 'gauge') {
  const out = [];
  if (help) {
    out.push(`# HELP ${name} ${help}`);
    out.push(`# TYPE ${name} ${type}`);
  }
  const labelText = labels && Object.keys(labels).length
    ? `{${Object.entries(labels).map(([k, v]) => `${k}="${esc(v)}"`).join(',')}}`
    : '';
  out.push(`${name}${labelText} ${Number.isFinite(Number(value)) ? Number(value) : 0}`);
  return out.join('\n');
}

export function renderPrometheus(ctx) {
  const { config, pool, quota, consumers, affinity, chatInFlight, modelsCacheAt, startedAt } = ctx;
  const now = Date.now();
  const accounts = pool.list();
  const enabled = accounts.filter((a) => a.enabled && !a.credentialMissing);
  const lines = [];

  lines.push(line('codefree_proxy_up', {}, 1, 'Proxy process is up'));
  lines.push(
    line(
      'codefree_proxy_info',
      { mode: accounts.length > 1 ? 'pool' : 'single', version: config.upstream.version, upstream: config.upstream.baseUrl },
      1,
      'Proxy build/runtime information',
    ),
  );
  if (startedAt) {
    lines.push(line('codefree_proxy_uptime_seconds', {}, Math.round((now - startedAt) / 1000), 'Process uptime in seconds', 'counter'));
  }

  lines.push(line('codefree_accounts', { state: 'total' }, accounts.length, 'Account counts by state'));
  lines.push(line('codefree_accounts', { state: 'enabled' }, enabled.length));
  lines.push(line('codefree_accounts', { state: 'ready' }, accounts.filter((a) => a.health === 'ready' && a.cooldownUntil <= now).length));
  lines.push(line('codefree_accounts', { state: 'cooling' }, accounts.filter((a) => a.cooldownUntil > now).length));
  lines.push(line('codefree_accounts', { state: 'auth_expired' }, accounts.filter((a) => a.health === 'auth-expired').length));
  lines.push(line('codefree_accounts', { state: 'disabled' }, accounts.filter((a) => !a.enabled || a.credentialMissing).length));

  for (const account of accounts) {
    const labels = { account: account.id, user_id: account.userId || '', label: account.label || '' };
    lines.push(
      line(
        'codefree_account_info',
        { ...labels, health: account.health, write_back: account.writeBack, enabled: String(account.enabled) },
        1,
        'Per-account static information',
      ),
    );
    lines.push(line('codefree_account_leases', labels, account.leases, 'Active concurrency leases'));
    lines.push(
      line(
        'codefree_account_sessions',
        labels,
        affinity ? affinity.countByAccount(account.id) : 0,
        'Sessions currently bound to this account',
      ),
    );
    lines.push(line('codefree_account_headroom', labels, quota.headroom(account.id), 'Estimated quota headroom ratio (0-1)'));
    lines.push(line('codefree_account_cooldown_seconds', labels, Math.max(0, Math.round((account.cooldownUntil - now) / 1000)), 'Remaining cooldown'));
    lines.push(line('codefree_account_requests_total', labels, account.stats.requests, 'Upstream attempts', 'counter'));
    lines.push(line('codefree_account_successes_total', labels, account.stats.successes, 'Successful chat requests', 'counter'));
    lines.push(line('codefree_account_failures_total', labels, account.stats.failures, 'Failed attempts', 'counter'));
    lines.push(line('codefree_account_tokens_total', { ...labels, direction: 'in' }, account.stats.tokensIn, 'Prompt tokens', 'counter'));
    lines.push(line('codefree_account_tokens_total', { ...labels, direction: 'out' }, account.stats.tokensOut, 'Completion tokens', 'counter'));
    if (account.stats.lastLatencyMs !== null) {
      lines.push(line('codefree_account_last_latency_ms', labels, account.stats.lastLatencyMs, 'Last successful request latency'));
    }
    lines.push(
      line(
        'codefree_account_last_used_timestamp_seconds',
        labels,
        account.stats.lastUsedAt ? Math.round(account.stats.lastUsedAt / 1000) : 0,
        'Last used timestamp',
      ),
    );
    lines.push(
      line(
        'codefree_account_refresh_timestamp_seconds',
        labels,
        account.stats.lastRefreshAt ? Math.round(account.stats.lastRefreshAt / 1000) : 0,
        'Last successful token refresh timestamp',
      ),
    );
    lines.push(
      line(
        'codefree_account_refresh_expires_in_seconds',
        labels,
        account.refreshTokenExpiresAt ? Math.round((account.refreshTokenExpiresAt - now) / 1000) : 0,
        'Refresh token remaining lifetime in seconds (0 = unknown)',
      ),
    );

    const snap = quota.get(account.id);
    if (snap?.windows) {
      for (const [period, window] of Object.entries(snap.windows)) {
        const wLabels = { ...labels, period };
        if (typeof window.usagePercent === 'number') {
          lines.push(line('codefree_quota_window_usage_percent', wLabels, window.usagePercent, 'Quota window usage percent'));
        }
        if (typeof window.used === 'number') lines.push(line('codefree_quota_window_used', wLabels, window.used, 'Quota window used tokens'));
        if (typeof window.limit === 'number') lines.push(line('codefree_quota_window_limit', wLabels, window.limit, 'Quota window limit tokens'));
        if (typeof window.resetAt === 'number') {
          lines.push(line('codefree_quota_window_reset_timestamp_seconds', wLabels, Math.round(window.resetAt / 1000), 'Quota window reset timestamp'));
        }
        if (typeof window.thresholdPercent === 'number') {
          lines.push(line('codefree_quota_window_threshold_percent', wLabels, window.thresholdPercent, 'Quota warning threshold percent'));
        }
      }
    }
    if (snap) {
      lines.push(
        line(
          'codefree_quota_bypassed',
          labels,
          snap.bypassed ? 1 : 0,
          '1 when quota is bypassed for this account',
        ),
      );
      if (typeof snap.canUpgrade === 'boolean') {
        lines.push(line('codefree_quota_can_upgrade', labels, snap.canUpgrade ? 1 : 0, 'Whether the account can upgrade its quota'));
      }
      if (typeof snap.enforced === 'boolean') {
        lines.push(line('codefree_quota_enforced', labels, snap.enforced ? 1 : 0, '1 when quota is enforced (ACTIVE, no reason, not VIP)'));
      }
      if (snap.quotaStatus) {
        lines.push(line('codefree_quota_status_info', { ...labels, status: snap.quotaStatus }, 1, 'Quota status from upstream (info metric)'));
      }
      if (snap.statusReason) {
        lines.push(
          line('codefree_quota_status_reason_info', { ...labels, reason: snap.statusReason }, 1, 'Quota bypass/reason from upstream (info metric)'),
        );
      }
      const workTime = quotaWorkTimeActive(snap.quotaWorkTime, now);
      if (workTime.known) {
        lines.push(
          line(
            'codefree_quota_worktime_active',
            labels,
            workTime.active ? 1 : 0,
            '1 when current time is inside the account quota work-time window',
          ),
        );
      }
      lines.push(
        line(
          'codefree_quota_fetched_timestamp_seconds',
          labels,
          snap.fetchedAt ? Math.round(snap.fetchedAt / 1000) : 0,
          'Last quota snapshot timestamp',
        ),
      );
    }
  }

  lines.push(line('codefree_pool_available', {}, accounts.filter((a) => a.available).length, 'Accounts currently selectable'));
  lines.push(line('codefree_pool_active_leases', {}, accounts.reduce((s, a) => s + a.leases, 0), 'Total active leases'));
  lines.push(line('codefree_sticky_sessions', {}, affinity ? affinity.size() : 0, 'Sticky session entries'));
  lines.push(line('codefree_chat_in_flight', {}, chatInFlight ?? 0, 'Chat requests currently in flight'));

  const consumerList = consumers?.snapshot ? consumers.snapshot() : [];
  lines.push(line('codefree_consumers', { state: 'enabled' }, consumers?.enabled ? 1 : 0, 'Consumer auth enabled flag'));
  lines.push(line('codefree_consumers', { state: 'total' }, consumerList.length));
  for (const c of consumerList) {
    const labels = { consumer: c.id, name: c.name };
    lines.push(line('codefree_consumer_info', { ...labels, rpm: c.rpm || 0, max_concurrent: c.maxConcurrent || 0 }, 1, 'Consumer configuration'));
    lines.push(line('codefree_consumer_requests_total', labels, c.total, 'Consumer request count', 'counter'));
    lines.push(line('codefree_consumer_active', labels, c.active, 'Consumer active requests'));
    lines.push(line('codefree_consumer_window_rpm', labels, c.windowRpm, 'Consumer requests in current 60s window'));
  }

  if (modelsCacheAt) {
    lines.push(line('codefree_models_cached_timestamp_seconds', {}, Math.round(modelsCacheAt / 1000), 'Model list cache timestamp'));
  }
  lines.push(line('codefree_quota_probe_enabled', {}, config.quota?.probe?.enabled ? 1 : 0, 'Active quota probe enabled'));
  lines.push(line('codefree_alerts_enabled', {}, config.alert?.enabled ? 1 : 0, 'Webhook alerts enabled'));

  return lines.join('\n') + '\n';
}
