import { useEffect, useState } from 'react';
import { api } from '../../api';
import type { UsageReport } from '../../../../src/services/liteLlmUsage';

export const USAGE_RANGE_LABEL: Record<number, string> = { 1: 'Today', 7: '7 days', 30: '30 days' };

/**
 * LiteLLM usage for a range; null while loading or when the request fails.
 * Reloads every 5 minutes, as before, and whenever refreshKey changes (the Refresh button).
 */
export function useUsage(days: number, refreshKey = 0): UsageReport | null {
  const [report, setReport] = useState<UsageReport | null>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      api
        .usage(days)
        .then((r) => live && setReport(r))
        .catch(() => live && setReport(null));
    load();
    const t = setInterval(load, 5 * 60 * 1000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [days, refreshKey]);
  return report;
}
