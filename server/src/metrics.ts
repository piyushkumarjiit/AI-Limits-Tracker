import type { QuotaView } from './quotaCache';

function escapeLabelValue(val: string): string {
  return val.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function formatLabels(labels: Record<string, string>): string {
  const parts = Object.entries(labels).map(
    ([k, v]) => `${k}="${escapeLabelValue(v)}"`
  );
  return `{${parts.join(',')}}`;
}

export function renderMetrics(view: QuotaView, now?: number): string {
  const lines: string[] = [];
  const t = now ?? Date.now();

  // Helper to extract common account labels
  const getAccountLabels = (acc: QuotaView['accounts'][number]) => ({
    provider: acc.provider,
    account: acc.id,
    auth_index: acc.cpa?.authIndex !== null && acc.cpa?.authIndex !== undefined ? acc.cpa.authIndex : '',
    email: acc.email || '',
  });

  // 1. alt_quota_used_ratio (gauge 0–1)
  lines.push('# HELP alt_quota_used_ratio Ratio of quota used per window [0, 1]');
  lines.push('# TYPE alt_quota_used_ratio gauge');
  for (const acc of view.accounts) {
    const accLabels = getAccountLabels(acc);
    for (const w of acc.windows) {
      if (w.usedPct !== null && Number.isFinite(w.usedPct)) {
        const ratio = Math.max(0, Math.min(1, Math.round((w.usedPct / 100) * 10000) / 10000));
        lines.push(`alt_quota_used_ratio${formatLabels({ ...accLabels, window: w.id })} ${ratio}`);
      }
    }
  }

  // 2. alt_quota_remaining_ratio (gauge 0–1)
  lines.push('# HELP alt_quota_remaining_ratio Ratio of quota remaining per window [0, 1]');
  lines.push('# TYPE alt_quota_remaining_ratio gauge');
  for (const acc of view.accounts) {
    const accLabels = getAccountLabels(acc);
    for (const w of acc.windows) {
      if (w.remainingPct !== null && Number.isFinite(w.remainingPct)) {
        const ratio = Math.max(0, Math.min(1, Math.round((w.remainingPct / 100) * 10000) / 10000));
        lines.push(`alt_quota_remaining_ratio${formatLabels({ ...accLabels, window: w.id })} ${ratio}`);
      }
    }
  }

  // 3. alt_quota_reset_timestamp_seconds (gauge)
  lines.push('# HELP alt_quota_reset_timestamp_seconds Timestamp in seconds when window resets');
  lines.push('# TYPE alt_quota_reset_timestamp_seconds gauge');
  for (const acc of view.accounts) {
    const accLabels = getAccountLabels(acc);
    for (const w of acc.windows) {
      if (w.resetsAt) {
        const resetMs = new Date(w.resetsAt).getTime();
        if (!Number.isNaN(resetMs)) {
          const resetSec = Math.floor(resetMs / 1000);
          lines.push(`alt_quota_reset_timestamp_seconds${formatLabels({ ...accLabels, window: w.id })} ${resetSec}`);
        }
      }
    }
  }

  // 4. alt_quota_burn_ratio_per_hour (gauge, omit when null)
  lines.push('# HELP alt_quota_burn_ratio_per_hour Burn rate ratio per hour [0, 1]');
  lines.push('# TYPE alt_quota_burn_ratio_per_hour gauge');
  for (const acc of view.accounts) {
    const accLabels = getAccountLabels(acc);
    for (const w of acc.windows) {
      if (w.burnPctPerHour !== null && Number.isFinite(w.burnPctPerHour)) {
        const ratio = Math.round((w.burnPctPerHour / 100) * 10000) / 10000;
        lines.push(`alt_quota_burn_ratio_per_hour${formatLabels({ ...accLabels, window: w.id })} ${ratio}`);
      }
    }
  }

  // 5. alt_quota_exhaust_timestamp_seconds (gauge, omit when null)
  lines.push('# HELP alt_quota_exhaust_timestamp_seconds Predicted quota exhaustion timestamp in seconds');
  lines.push('# TYPE alt_quota_exhaust_timestamp_seconds gauge');
  for (const acc of view.accounts) {
    const accLabels = getAccountLabels(acc);
    for (const w of acc.windows) {
      if (w.exhaustAt) {
        const exhaustMs = new Date(w.exhaustAt).getTime();
        if (!Number.isNaN(exhaustMs)) {
          const exhaustSec = Math.floor(exhaustMs / 1000);
          lines.push(`alt_quota_exhaust_timestamp_seconds${formatLabels({ ...accLabels, window: w.id })} ${exhaustSec}`);
        }
      }
    }
  }

  // 6. alt_account_headroom_ratio (gauge 0–1)
  lines.push('# HELP alt_account_headroom_ratio Headroom score of account [0, 1]');
  lines.push('# TYPE alt_account_headroom_ratio gauge');
  for (const acc of view.accounts) {
    if (acc.headroom !== null && Number.isFinite(acc.headroom)) {
      const ratio = Math.max(0, Math.min(1, Math.round(acc.headroom * 10000) / 10000));
      lines.push(`alt_account_headroom_ratio${formatLabels(getAccountLabels(acc))} ${ratio}`);
    }
  }

  // 7. alt_account_up (gauge 0/1: status==ok && !stale)
  lines.push('# HELP alt_account_up Account operational status (1 if ok and not stale, 0 otherwise)');
  lines.push('# TYPE alt_account_up gauge');
  for (const acc of view.accounts) {
    const accLabels = getAccountLabels(acc);
    const isUp = acc.status === 'ok' && !acc.stale ? 1 : 0;
    lines.push(`alt_account_up${formatLabels({ ...accLabels, status: acc.status })} ${isUp}`);
  }

  // 8. alt_account_last_success_timestamp_seconds (gauge)
  lines.push('# HELP alt_account_last_success_timestamp_seconds Timestamp in seconds of last successful sync');
  lines.push('# TYPE alt_account_last_success_timestamp_seconds gauge');
  for (const acc of view.accounts) {
    if (acc.fetchedAt && (acc.status === 'ok' || acc.status === 'idle')) {
      const fetchMs = new Date(acc.fetchedAt).getTime();
      if (!Number.isNaN(fetchMs)) {
        const fetchSec = Math.floor(fetchMs / 1000);
        lines.push(`alt_account_last_success_timestamp_seconds${formatLabels(getAccountLabels(acc))} ${fetchSec}`);
      }
    }
  }

  // 9. alt_cpa_routing_weight (gauge: kind=planned|applied)
  lines.push('# HELP alt_cpa_routing_weight CPA routing weight assigned to account');
  lines.push('# TYPE alt_cpa_routing_weight gauge');
  for (const acc of view.accounts) {
    const accLabels = getAccountLabels(acc);
    if (acc.routing.planned !== null && Number.isFinite(acc.routing.planned)) {
      lines.push(`alt_cpa_routing_weight${formatLabels({ ...accLabels, kind: 'planned' })} ${acc.routing.planned}`);
    }
    if (acc.routing.applied !== null && Number.isFinite(acc.routing.applied)) {
      lines.push(`alt_cpa_routing_weight${formatLabels({ ...accLabels, kind: 'applied' })} ${acc.routing.applied}`);
    }
  }

  // 10. alt_cpa_routing_writes_total (counter: result=ok|error|skipped)
  lines.push('# HELP alt_cpa_routing_writes_total Total routing writes attempted');
  lines.push('# TYPE alt_cpa_routing_writes_total counter');
  lines.push(`alt_cpa_routing_writes_total{result="ok"} 0`);
  lines.push(`alt_cpa_routing_writes_total{result="error"} 0`);
  lines.push(`alt_cpa_routing_writes_total{result="skipped"} 0`);

  // 11. alt_cpa_routing_blocked (gauge: reason)
  lines.push('# HELP alt_cpa_routing_blocked CPA routing blocked state');
  lines.push('# TYPE alt_cpa_routing_blocked gauge');
  if (view.cpa.routingBlocked) {
    lines.push(`alt_cpa_routing_blocked${formatLabels({ reason: view.cpa.routingBlocked })} 1`);
  }

  // 12. alt_cpa_discovery_last_success_timestamp_seconds (gauge)
  lines.push('# HELP alt_cpa_discovery_last_success_timestamp_seconds Timestamp in seconds of last successful discovery');
  lines.push('# TYPE alt_cpa_discovery_last_success_timestamp_seconds gauge');
  if (view.cpa.lastDiscoveryAt && view.cpa.lastDiscoveryOk) {
    const discMs = new Date(view.cpa.lastDiscoveryAt).getTime();
    if (!Number.isNaN(discMs)) {
      lines.push(`alt_cpa_discovery_last_success_timestamp_seconds ${Math.floor(discMs / 1000)}`);
    }
  }

  // 13. alt_cpa_credentials (gauge: provider, link_state)
  lines.push('# HELP alt_cpa_credentials Total registered CPA credentials');
  lines.push('# TYPE alt_cpa_credentials gauge');
  const credCounts: Record<string, Record<string, number>> = {};
  for (const acc of view.accounts) {
    if (acc.source === 'cpa' && acc.cpa) {
      const p = acc.provider;
      const state = acc.cpa.linkState;
      if (!credCounts[p]) credCounts[p] = {};
      credCounts[p][state] = (credCounts[p][state] || 0) + 1;
    }
  }
  for (const [p, states] of Object.entries(credCounts)) {
    for (const [st, count] of Object.entries(states)) {
      lines.push(`alt_cpa_credentials${formatLabels({ provider: p, link_state: st })} ${count}`);
    }
  }

  // 14. alt_cpa_ignored_credentials (gauge: provider)
  lines.push('# HELP alt_cpa_ignored_credentials Total CPA credentials ignored by provider');
  lines.push('# TYPE alt_cpa_ignored_credentials gauge');

  // 15. alt_cpa_requests_total (counter: endpoint=api_call|list|patch|refresh, outcome)
  lines.push('# HELP alt_cpa_requests_total Total CPA API requests performed');
  lines.push('# TYPE alt_cpa_requests_total counter');
  lines.push(`alt_cpa_requests_total{endpoint="list",outcome="success"} ${view.cpa.lastDiscoveryOk ? 1 : 0}`);

  return lines.join('\n') + '\n';
}
