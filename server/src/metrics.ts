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

  // 1. alt_headroom_score
  lines.push('# HELP alt_headroom_score Normalised headroom score [0, 1] for account');
  lines.push('# TYPE alt_headroom_score gauge');
  for (const acc of view.accounts) {
    if (acc.headroom_score !== null && Number.isFinite(acc.headroom_score)) {
      const labels = {
        provider: acc.provider,
        account: acc.id,
        auth_index: acc.auth_index !== null ? acc.auth_index : '',
        email: acc.email || '',
      };
      lines.push(`alt_headroom_score${formatLabels(labels)} ${acc.headroom_score}`);
    }
  }

  // 2. alt_effective_remaining_ratio
  lines.push('# HELP alt_effective_remaining_ratio Effective quota remaining as a fraction [0, 1]');
  lines.push('# TYPE alt_effective_remaining_ratio gauge');
  for (const acc of view.accounts) {
    if (acc.effective_remaining_percent !== null && Number.isFinite(acc.effective_remaining_percent)) {
      const ratio = Math.max(0, Math.min(1, Math.round((acc.effective_remaining_percent / 100) * 10000) / 10000));
      const labels = {
        provider: acc.provider,
        account: acc.id,
        auth_index: acc.auth_index !== null ? acc.auth_index : '',
        email: acc.email || '',
      };
      lines.push(`alt_effective_remaining_ratio${formatLabels(labels)} ${ratio}`);
    }
  }

  // 3. alt_current_weight
  lines.push('# HELP alt_current_weight Active proxy weight assigned to account');
  lines.push('# TYPE alt_current_weight gauge');
  for (const acc of view.accounts) {
    if (acc.current_weight !== null && Number.isFinite(acc.current_weight)) {
      const labels = {
        provider: acc.provider,
        account: acc.id,
        auth_index: acc.auth_index !== null ? acc.auth_index : '',
        email: acc.email || '',
      };
      lines.push(`alt_current_weight${formatLabels(labels)} ${acc.current_weight}`);
    }
  }

  // 4. alt_target_weight
  lines.push('# HELP alt_target_weight Target proxy weight computed by routing planner');
  lines.push('# TYPE alt_target_weight gauge');
  for (const acc of view.accounts) {
    if (acc.target_weight !== null && Number.isFinite(acc.target_weight)) {
      const labels = {
        provider: acc.provider,
        account: acc.id,
        auth_index: acc.auth_index !== null ? acc.auth_index : '',
        email: acc.email || '',
      };
      lines.push(`alt_target_weight${formatLabels(labels)} ${acc.target_weight}`);
    }
  }

  // 5. alt_cooldown
  lines.push('# HELP alt_cooldown Binary flag indicating whether account is in cooldown (1) or active (0)');
  lines.push('# TYPE alt_cooldown gauge');
  for (const acc of view.accounts) {
    const labels = {
      provider: acc.provider,
      account: acc.id,
      auth_index: acc.auth_index !== null ? acc.auth_index : '',
      email: acc.email || '',
    };
    lines.push(`alt_cooldown${formatLabels(labels)} ${acc.cooldown ? 1 : 0}`);
  }

  // 6. alt_window_remaining_ratio
  lines.push('# HELP alt_window_remaining_ratio Remaining quota fraction [0, 1] per window');
  lines.push('# TYPE alt_window_remaining_ratio gauge');
  for (const acc of view.accounts) {
    for (const b of acc.buckets) {
      if (b.remaining_percent !== null && Number.isFinite(b.remaining_percent)) {
        const ratio = Math.max(0, Math.min(1, Math.round((b.remaining_percent / 100) * 10000) / 10000));
        const labels = {
          provider: acc.provider,
          account: acc.id,
          auth_index: acc.auth_index !== null ? acc.auth_index : '',
          email: acc.email || '',
          window: b.id,
        };
        lines.push(`alt_window_remaining_ratio${formatLabels(labels)} ${ratio}`);
      }
    }
  }

  // 7. alt_window_reset_timestamp_seconds
  lines.push('# HELP alt_window_reset_timestamp_seconds Epoch seconds at which the window resets');
  lines.push('# TYPE alt_window_reset_timestamp_seconds gauge');
  for (const acc of view.accounts) {
    for (const b of acc.buckets) {
      if (b.resets_at) {
        const resetMs = new Date(b.resets_at).getTime();
        if (!Number.isNaN(resetMs)) {
          const resetSec = Math.floor(resetMs / 1000);
          const labels = {
            provider: acc.provider,
            account: acc.id,
            auth_index: acc.auth_index !== null ? acc.auth_index : '',
            email: acc.email || '',
            window: b.id,
          };
          lines.push(`alt_window_reset_timestamp_seconds${formatLabels(labels)} ${resetSec}`);
        }
      }
    }
  }

  // 8. alt_accounts_total
  lines.push('# HELP alt_accounts_total Total number of registered accounts by provider');
  lines.push('# TYPE alt_accounts_total gauge');
  for (const [prov, counts] of Object.entries(view.totals.providers)) {
    lines.push(`alt_accounts_total${formatLabels({ provider: prov })} ${counts.total}`);
  }

  // 9. alt_accounts_active
  lines.push('# HELP alt_accounts_active Number of active (syncing) accounts by provider');
  lines.push('# TYPE alt_accounts_active gauge');
  for (const [prov, counts] of Object.entries(view.totals.providers)) {
    lines.push(`alt_accounts_active${formatLabels({ provider: prov })} ${counts.active}`);
  }

  // 10. alt_headroom_available_total
  lines.push('# HELP alt_headroom_available_total Aggregate headroom units across all accounts');
  lines.push('# TYPE alt_headroom_available_total gauge');
  lines.push(`alt_headroom_available_total ${view.totals.headroom_available}`);

  // End with trailing newline
  return lines.join('\n') + '\n';
}
