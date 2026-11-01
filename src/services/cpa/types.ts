/**
 * TypeScript types for CLIProxyAPI (CPA) management interface.
 * Implements data structures specified in §2.1 of CLIProxy Quota Integration Spec.
 */

export interface CpaCooldownView {
  active: boolean;
  until?: string;
  reason?: string;
  scope?: string;
}

export interface CpaCredential {
  auth_index: string;
  name: string;
  provider: string;
  email?: string;
  project_id?: string;
  status?: string;
  disabled?: boolean;
  cooldowns?: Record<string, CpaCooldownView>;
  metadata?: Record<string, unknown>;
  label?: string;
  account?: string;
  account_type?: string;
  runtime_only?: boolean;
  source?: string;
  status_message?: string;
  requires_sign_in?: boolean;
  id_token?: { chatgpt_account_id?: string; plan_type?: string; [key: string]: unknown };
  plan?: string;
  [key: string]: unknown;
}

export interface CpaListResponse {
  observed_at: string;
  files: CpaCredential[];
  total?: number;
  page?: number;
  page_size?: number;
  has_more?: boolean;
}

export interface CpaApiCallRequest {
  auth_index: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  header?: Record<string, string>;
  data?: string;
}

export interface CpaApiCallResponse {
  status_code: number;
  header: Record<string, string[]>;
  body: string;
}

export interface CpaPatchFieldsRequest {
  name: string;
  [key: string]: unknown;
}

export interface LinkRoutingState {
  applied?: number;
  at?: number;
  cooldown?: boolean;
  managed?: boolean;
  reason?: string;
  [key: string]: unknown;
}

export interface CpaForceRefreshRequest {
  name?: string;
  auth_index?: string;
  all?: boolean;
}

export interface CpaForceRefreshResult {
  ok: boolean;
  auth?: Record<string, unknown>;
  results?: Array<Record<string, unknown>>;
  error?: string;
}

export interface CpaRoutingStrategyResponse {
  strategy: string;
}
