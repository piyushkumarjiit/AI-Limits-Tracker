/**
 * LiteLLM usage: per-alias, per-model and per-provider-family totals.
 *
 * Reads LiteLLM's pre-aggregated daily activity (`/user/daily/activity`, the same source as
 * LiteLLM's own usage page) and its alias map (`/model/info`). Both are small, unlike raw spend
 * logs (tens of MB per day). Accounts come from CLIProxy's usage feed and are joined on the
 * model name, because LiteLLM aliases route to models that CLIProxy serves from accounts.
 */

/** One row of CLIProxy's usage feed, aggregated by account email and model. */
export interface UsageFeedRow {
  email: string;
  model: string;
  requests: number;
  totalTokens: number;
}

export interface UsageMetrics {
  requests: number;
  failed: number;
  tokens: number;
  spend: number;
}

export interface AliasAccountUsage {
  accountId: string | null;
  email: string;
  requests: number;
  tokens: number;
}

export interface AliasModel {
  /** Model as configured in LiteLLM, e.g. "gemini/gemini-3.8-flash-high". */
  model: string;
  family: string;
  /** Accounts that served this model in the last 24 hours (CLIProxy usage feed). */
  accounts: AliasAccountUsage[];
  /** Other aliases routed to the same model; account shares are combined across them. */
  sharedWith: string[];
}

export interface AliasUsage extends UsageMetrics {
  alias: string;
  family: string;
  models: AliasModel[];
}

export interface FamilyUsage extends UsageMetrics {
  family: string;
  aliases: string[];
}

export interface UsageReport {
  connected: boolean;
  days: number;
  startDate: string;
  endDate: string;
  totals: UsageMetrics & { successful: number; cacheReadTokens: number };
  aliases: AliasUsage[];
  families: FamilyUsage[];
  notes: string[];
  fetchedAt: string;
}

const FAMILY_RULES: Array<[RegExp, string]> = [
  [/claude|anthropic/, 'Anthropic'],
  [/gemini|gemma|antigravity|vertex|google/, 'Google'],
  [/deepseek/, 'DeepSeek'],
  [/gpt|chatgpt|codex|\bo[1-9]\b|openai/, 'OpenAI'],
  [/mistral|codestral/, 'Mistral'],
  [/qwen/, 'Qwen'],
  [/grok|xai/, 'xAI'],
  [/llama|meta/, 'Meta'],
];

/**
 * Provider family of a model name. Uses the model itself rather than LiteLLM's provider prefix,
 * because an OpenAI-compatible route (e.g. "openai/claude-sonnet-5-5" through CLIProxy) still
 * serves the model's real vendor.
 */
export function modelFamily(model: string, fallbackProvider?: string): string {
  const m = model.toLowerCase();
  const last = m.split('/').pop() ?? m;
  for (const [re, fam] of FAMILY_RULES) if (re.test(last)) return fam;
  for (const [re, fam] of FAMILY_RULES) if (re.test(m)) return fam;
  const p = (fallbackProvider || m.split('/')[0] || '').trim();
  return p ? p.charAt(0).toUpperCase() + p.slice(1) : 'Other';
}

/** FQD account provider type -> family shown on the overview. */
export function accountFamily(providerType: string): string {
  if (providerType === 'antigravity' || providerType === 'gemini') return 'Google';
  if (providerType === 'claude') return 'Anthropic';
  if (providerType === 'chatgpt') return 'OpenAI';
  return modelFamily(providerType);
}

/** Model name without provider prefixes, lower case: the key shared by LiteLLM and CLIProxy. */
export function modelKey(model: string): string {
  return (model.toLowerCase().split('/').pop() ?? '').trim();
}

const metricsOf = (m: any): UsageMetrics => ({
  requests: Number(m?.api_requests) || 0,
  failed: Number(m?.failed_requests) || 0,
  tokens: Number(m?.total_tokens) || 0,
  spend: Number(m?.spend) || 0,
});

const addInto = (t: UsageMetrics, m: UsageMetrics) => {
  t.requests += m.requests;
  t.failed += m.failed;
  t.tokens += m.tokens;
  t.spend += m.spend;
};

/** Builds the report from LiteLLM responses; pure so it can be tested without a server. */
export function summarizeLiteLlm(
  activity: any,
  modelInfo: any,
  cliProxyUsage: UsageFeedRow[],
  idByEmail: Map<string, string>,
  range: { days: number; startDate: string; endDate: string }
): Omit<UsageReport, 'connected' | 'notes' | 'fetchedAt'> {
  // alias -> configured models
  const aliasModels = new Map<string, Set<string>>();
  for (const d of Array.isArray(modelInfo?.data) ? modelInfo.data : []) {
    const alias = typeof d?.model_name === 'string' ? d.model_name : '';
    const model = typeof d?.litellm_params?.model === 'string' ? d.litellm_params.model : '';
    if (!alias || !model) continue;
    (aliasModels.get(alias) ?? aliasModels.set(alias, new Set()).get(alias)!).add(model);
  }
  const providerOf = new Map<string, string>();
  for (const d of Array.isArray(modelInfo?.data) ? modelInfo.data : []) {
    if (typeof d?.litellm_params?.model === 'string' && typeof d?.model_info?.litellm_provider === 'string') {
      providerOf.set(d.litellm_params.model, d.model_info.litellm_provider);
    }
  }

  // Aliases sharing a model, keyed by model key.
  const aliasesByKey = new Map<string, Set<string>>();
  for (const [alias, models] of aliasModels) {
    for (const m of models) (aliasesByKey.get(modelKey(m)) ?? aliasesByKey.set(modelKey(m), new Set()).get(modelKey(m))!).add(alias);
  }

  // CLIProxy usage by model key -> accounts.
  const accountsByKey = new Map<string, Map<string, AliasAccountUsage>>();
  for (const u of cliProxyUsage) {
    const key = modelKey(u.model);
    const byEmail = accountsByKey.get(key) ?? accountsByKey.set(key, new Map()).get(key)!;
    const email = u.email.toLowerCase();
    const a = byEmail.get(email) ?? { accountId: idByEmail.get(email) ?? null, email: u.email, requests: 0, tokens: 0 };
    a.requests += u.requests;
    a.tokens += u.totalTokens;
    byEmail.set(email, a);
  }

  // A failed call is logged under the alias name instead of a model; resolve it through the alias.
  const familyOfModel = (model: string): string => {
    const viaAlias = aliasModels.get(model);
    if (viaAlias?.size) return modelFamily([...viaAlias][0], providerOf.get([...viaAlias][0]));
    const fam = modelFamily(model, providerOf.get(model));
    return model.includes('/') || providerOf.has(model) || FAMILY_RULES.some(([, f]) => f === fam) ? fam : 'Other';
  };

  const aliasTotals = new Map<string, UsageMetrics>();
  const familyTotals = new Map<string, UsageMetrics>();
  const totals = { requests: 0, failed: 0, tokens: 0, spend: 0, successful: 0, cacheReadTokens: 0 };
  for (const day of Array.isArray(activity?.results) ? activity.results : []) {
    const b = day?.breakdown ?? {};
    for (const [alias, v] of Object.entries<any>(b.model_groups ?? {})) {
      const t = aliasTotals.get(alias) ?? { requests: 0, failed: 0, tokens: 0, spend: 0 };
      addInto(t, metricsOf(v?.metrics));
      aliasTotals.set(alias, t);
    }
    for (const [model, v] of Object.entries<any>(b.models ?? {})) {
      const fam = familyOfModel(model);
      const t = familyTotals.get(fam) ?? { requests: 0, failed: 0, tokens: 0, spend: 0 };
      addInto(t, metricsOf(v?.metrics));
      familyTotals.set(fam, t);
    }
  }
  const meta = activity?.metadata ?? {};
  totals.requests = Number(meta.total_api_requests) || 0;
  totals.successful = Number(meta.total_successful_requests) || 0;
  totals.failed = Number(meta.total_failed_requests) || 0;
  totals.tokens = Number(meta.total_tokens) || 0;
  totals.spend = Number(meta.total_spend) || 0;
  totals.cacheReadTokens = Number(meta.total_cache_read_input_tokens) || 0;

  const aliases: AliasUsage[] = [...aliasTotals.entries()]
    .filter(([alias, t]) => alias && t.requests > 0)
    .map(([alias, t]) => {
      const configured = [...(aliasModels.get(alias) ?? [])];
      const models: AliasModel[] = configured.map((model) => {
        const key = modelKey(model);
        return {
          model,
          family: modelFamily(model, providerOf.get(model)),
          accounts: [...(accountsByKey.get(key)?.values() ?? [])].sort((x, y) => y.requests - x.requests),
          sharedWith: [...(aliasesByKey.get(key) ?? [])].filter((a) => a !== alias && aliasTotals.has(a)).sort(),
        };
      });
      const family = models[0]?.family ?? familyOfModel(alias);
      return { alias, family, models, ...t };
    })
    .sort((x, y) => y.spend - x.spend || y.requests - x.requests);

  const families: FamilyUsage[] = [...familyTotals.entries()]
    .filter(([, t]) => t.requests > 0)
    .map(([family, t]) => ({ family, ...t, aliases: aliases.filter((a) => a.family === family).map((a) => a.alias) }))
    .sort((x, y) => y.spend - x.spend || y.requests - x.requests);

  return { ...range, totals, aliases, families };
}

export const USAGE_RANGES = [1, 7, 30] as const;

export class LiteLlmUsageService {
  private cache = new Map<number, { report: UsageReport; expiresAt: number }>();
  private static readonly TTL_MS = 5 * 60 * 1000;

  constructor(
    private readonly getJson: (path: string, timeoutMs?: number) => Promise<{ status: number; body: any } | null>,
    private readonly usageSummary: (sinceMs: number) => UsageFeedRow[] = () => []
  ) {}

  async get(days: number, idByEmail: Map<string, string>): Promise<UsageReport> {
    const span = (USAGE_RANGES as readonly number[]).includes(days) ? days : 1;
    const now = Date.now();
    const hit = this.cache.get(span);
    if (hit && now < hit.expiresAt) return hit.report;

    const day = (t: number) => new Date(t).toISOString().slice(0, 10);
    const range = { days: span, startDate: day(now - (span - 1) * 86400000), endDate: day(now) };
    const empty: UsageReport = {
      connected: false,
      ...range,
      totals: { requests: 0, failed: 0, tokens: 0, spend: 0, successful: 0, cacheReadTokens: 0 },
      aliases: [],
      families: [],
      notes: [],
      fetchedAt: new Date(now).toISOString(),
    };

    const activity = await this.getJson(
      `/user/daily/activity?start_date=${range.startDate}&end_date=${range.endDate}&page_size=1000`,
      20000
    );
    if (!activity) {
      empty.notes.push('LiteLLM is not configured (set LITELLM_URL and an admin-read LITELLM_KEY).');
      return empty;
    }
    if (activity.status === 401 || activity.status === 403) {
      empty.notes.push('LiteLLM rejected the key; usage needs an admin or proxy_admin_viewer key in LITELLM_KEY.');
      return empty;
    }
    if (activity.status !== 200 || !activity.body || !Array.isArray(activity.body.results)) {
      empty.notes.push(activity.status === 0 ? 'LiteLLM did not answer (check LITELLM_URL).' : 'LiteLLM usage returned an unrecognized format.');
      return empty;
    }
    const info = await this.getJson('/model/info', 10000);
    const notes: string[] = [];
    if (!info || info.status !== 200) notes.push('LiteLLM model list unavailable; aliases are shown without their models.');
    if (activity.body.metadata?.has_more) notes.push('LiteLLM returned more than one page of activity; totals may be partial.');

    const summary = summarizeLiteLlm(activity.body, info?.body, this.usageSummary(now - 86400000), idByEmail, range);
    const report: UsageReport = { connected: true, ...summary, notes, fetchedAt: new Date(now).toISOString() };
    this.cache.set(span, { report, expiresAt: now + LiteLlmUsageService.TTL_MS });
    return report;
  }
}
