import { modelFamily, modelKey, summarizeLiteLlm } from '../src/services/liteLlmUsage';

let failed = 0;
function check(cond: boolean, name: string) {
  console.log(`  ${cond ? '✓ [PASS]' : '✗ [FAIL]'} ${name}`);
  if (!cond) failed++;
}

console.log('LiteLLM usage summary');
check(modelFamily('openai/claude-sonnet-5-5') === 'Anthropic', 'family follows the model, not the OpenAI-compatible prefix');
check(modelFamily('gemini/gemini-3.8-flash-high') === 'Google', 'gemini maps to Google');
check(modelFamily('openrouter/deepseek/deepseek-v4.1-flash') === 'DeepSeek', 'openrouter deepseek maps to DeepSeek');
check(modelFamily('acme/house-model') === 'Acme', 'unknown vendors use the provider prefix');
check(modelKey('gemini/gemini-3.8-flash-high') === 'gemini-3.8-flash-high', 'model key strips prefixes');

const m = (requests: number, spend: number, failedReq = 0) => ({ metrics: { api_requests: requests, failed_requests: failedReq, total_tokens: requests * 10, spend } });
const activity = {
  metadata: { total_api_requests: 13, total_successful_requests: 12, total_failed_requests: 1, total_tokens: 130, total_spend: 3.5 },
  results: [
    { breakdown: { model_groups: { captain: m(5, 2), 'crew-flash': m(3, 1, 1) }, models: { 'gemini/gemini-3.8-flash-high': m(8, 3, 1) } } },
    { breakdown: { model_groups: { deepseek: m(5, 0.5) }, models: { 'deepseek/deepseek-flash': m(5, 0.5), captain: m(2, 0, 2), 'unknown-model': m(1, 0, 1) } } },
  ],
};
const info = {
  data: [
    { model_name: 'captain', litellm_params: { model: 'gemini/gemini-3.8-flash-high' }, model_info: { litellm_provider: 'gemini' } },
    { model_name: 'crew-flash', litellm_params: { model: 'gemini/gemini-3.8-flash-high' }, model_info: { litellm_provider: 'gemini' } },
    { model_name: 'deepseek', litellm_params: { model: 'deepseek/deepseek-flash' }, model_info: { litellm_provider: 'deepseek' } },
  ],
};
const usage = [
  { email: 'A@x.com', model: 'gemini-3.8-flash-high', requests: 6, inputTokens: 0, outputTokens: 0, totalTokens: 60 },
  { email: 'b@x.com', model: 'gemini-3.8-flash-high', requests: 2, inputTokens: 0, outputTokens: 0, totalTokens: 20 },
] as any;
const r = summarizeLiteLlm(activity, info, usage, new Map([['a@x.com', 'acc-1']]), { days: 1, startDate: 'd', endDate: 'd' });
check(r.totals.requests === 13 && r.totals.spend === 3.5, 'totals come from LiteLLM metadata');
check(r.aliases[0].alias === 'captain' && r.aliases[0].spend === 2, 'aliases sorted by spend');
const captain = r.aliases.find((a) => a.alias === 'captain')!;
check(captain.models[0].accounts.length === 2 && captain.models[0].accounts[0].accountId === 'acc-1', 'accounts joined on model key, matched to FQD ids by email');
check(captain.models[0].sharedWith.join() === 'crew-flash', 'aliases sharing a model are flagged');
check(r.aliases.find((a) => a.alias === 'crew-flash')!.failed === 1, 'failed requests kept per alias');
const fams = Object.fromEntries(r.families.map((f) => [f.family, f]));
check(fams.Google?.requests === 10 && fams.DeepSeek?.requests === 5, 'families aggregate model breakdown');
check(fams.DeepSeek?.aliases.join() === 'deepseek', 'families list their aliases');
check(fams.Google?.failed === 3 && !fams.Captain, 'failed calls logged under an alias name count toward its family');
check(fams.Other?.requests === 1 && !fams['Unknown-model'], 'unrecognized model names fall into Other');

if (failed) {
  console.error(`${failed} LiteLLM usage test(s) failed`);
  process.exit(1);
}
