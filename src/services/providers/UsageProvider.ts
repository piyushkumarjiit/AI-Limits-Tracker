import { AccountCredentials, ProviderType, UsageSnapshot } from '../../models/types';

export interface ProviderFetchResult {
  snapshot: UsageSnapshot;
  updatedCredentials?: AccountCredentials;
}

export interface FetchUsageOptions {
  /** Probe even though CLIProxy reports the credential as disabled (FQD disabled it itself). */
  allowDisabled?: boolean;
}

export interface UsageProvider {
  readonly id: string;
  readonly type: ProviderType;
  readonly name: string;

  validateCredentials(credentials: AccountCredentials): boolean;
  fetchUsage(accountId: string, credentials: AccountCredentials, options?: FetchUsageOptions): Promise<ProviderFetchResult>;
}
