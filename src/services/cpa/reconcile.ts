import type { AccountCredentials, AccountEntity, ProviderType } from '../../models/types';
import type { CpaCredential } from './types';

export type ServerAccount = AccountEntity;

export type ReconcileActionKind =
  | 'created'
  | 'updated'
  | 'relinked'
  | 'unlinked'
  | 'purged'
  | 'adopted';

export interface ReconcileAction {
  kind: ReconcileActionKind;
  accountId: string;
  cpaName: string;
}

export interface CpaLink {
  accountId: string;
  identityKey: string;
  cpaName: string;
  authIndex: string;
  state: 'linked' | 'unlinked';
  lastSeenAt: number;
  unlinkedAt?: number | null;
  routingJson?: string | null;
}

export interface ReconcileOptions {
  purgeDays: number;
  adoptExisting: boolean;
  emptyStreak: number;
}

export interface ReconcileResult {
  actions: ReconcileAction[];
  links: CpaLink[];
  accountUpserts: ServerAccount[];
  credUpserts: Array<[string, AccountCredentials]>;
  deletes: string[];
}

const CPA_ALLOWED_PROVIDERS = new Set(['claude', 'codex', 'antigravity']);

export function isReconcilableCpaEntry(entry: CpaCredential): boolean {
  if (!entry || !entry.provider) return false;
  const p = entry.provider.toLowerCase().trim();
  if (!CPA_ALLOWED_PROVIDERS.has(p)) return false;
  if (entry.runtime_only === true) return false;
  if (entry.source !== 'file') return false;
  return true;
}

export function cpaToTrackerProvider(cpaProvider: string): ProviderType {
  const p = cpaProvider.toLowerCase().trim();
  if (p === 'codex') return 'chatgpt';
  if (p === 'claude') return 'claude';
  if (p === 'antigravity') return 'antigravity';
  return p as ProviderType;
}

export function buildIdentityKey(entry: {
  provider: string;
  email?: string;
  account?: string;
  name: string;
}): string {
  const p = entry.provider.toLowerCase().trim();
  const ident = (entry.email || entry.account || entry.name).toLowerCase().trim();
  return `${p}:${ident}`;
}

export function planOf(entry: CpaCredential): string {
  const raw =
    (entry.id_token?.plan_type as string) ||
    (entry.account_type as string) ||
    (entry.plan as string) ||
    '';
  if (!raw) return '';
  const lower = raw.toLowerCase().trim();
  if (lower === 'plus') return 'Plus';
  if (lower === 'pro') return 'Pro';
  if (lower === 'team') return 'Team';
  if (lower === 'free') return 'Free';
  if (lower.startsWith('max')) {
    return raw.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return raw.trim();
}

/**
 * Pure core reconciliation logic (§3.2–§3.4 of CLIProxy Quota Integration Spec).
 */
export function reconcile(
  entries: CpaCredential[],
  links: CpaLink[],
  accounts: ServerAccount[],
  now: number,
  opts: { purgeDays: number; adoptExisting: boolean; emptyStreak: number },
  existingCreds?: Map<string, AccountCredentials>
): ReconcileResult {
  const actions: ReconcileAction[] = [];
  const accountUpserts: ServerAccount[] = [];
  const credUpserts: Array<[string, AccountCredentials]> = [];
  const deletes: string[] = [];

  // Clone links and accounts so the inputs remain immutable
  const currentLinks: CpaLink[] = links.map((l) => ({ ...l }));
  const currentAccounts: ServerAccount[] = accounts.map((a) => ({ ...a }));

  // Filter per §3.3: provider ∈ {claude, codex, antigravity}, runtime_only !== true, source === 'file'
  const filteredEntries = entries.filter(isReconcilableCpaEntry);

  const seen = new Set<string>();
  const matchedLinkAccountIds = new Set<string>();
  const seenIdentityKeys = new Set<string>();
  for (const l of currentLinks) {
    seenIdentityKeys.add(l.identityKey);
  }

  // Determine maximum order index for positioning new accounts
  let maxOrderIndex = currentAccounts.reduce(
    (max, a) => (a.orderIndex > max ? a.orderIndex : max),
    -1
  );

  for (const entry of filteredEntries) {
    let entryIdentityKey = buildIdentityKey(entry);

    // Matching order per §3.2:
    // (1) cpa_links.auth_index == entry.auth_index
    // (2) cpa_links.cpa_name == entry.name
    // (3) identity_key == provider:lower(email || account || name)
    let matchedLink = currentLinks.find(
      (l) => !matchedLinkAccountIds.has(l.accountId) && l.authIndex === entry.auth_index
    );
    if (!matchedLink) {
      matchedLink = currentLinks.find(
        (l) => !matchedLinkAccountIds.has(l.accountId) && l.cpaName === entry.name
      );
    }
    if (!matchedLink) {
      matchedLink = currentLinks.find(
        (l) => !matchedLinkAccountIds.has(l.accountId) && l.identityKey === entryIdentityKey
      );
    }

    if (matchedLink) {
      matchedLinkAccountIds.add(matchedLink.accountId);
      seen.add(matchedLink.accountId);

      // If updating identity key, ensure no conflict with another link
      if (
        matchedLink.identityKey !== entryIdentityKey &&
        seenIdentityKeys.has(entryIdentityKey)
      ) {
        entryIdentityKey = `${entryIdentityKey}:${entry.name.toLowerCase().trim()}`;
      }

      const isUnlinked = matchedLink.state === 'unlinked';
      const wasRenamedOrReindexed =
        matchedLink.authIndex !== entry.auth_index ||
        matchedLink.cpaName !== entry.name ||
        matchedLink.identityKey !== entryIdentityKey;

      seenIdentityKeys.delete(matchedLink.identityKey);
      matchedLink.authIndex = entry.auth_index;
      matchedLink.cpaName = entry.name;
      matchedLink.identityKey = entryIdentityKey;
      seenIdentityKeys.add(entryIdentityKey);
      matchedLink.lastSeenAt = now;

      let acc = currentAccounts.find((a) => a.id === matchedLink.accountId);

      const statusHintRequiresReauth =
        entry.requires_sign_in === true || entry.status === 'error';
      const statusHintDisabled = entry.disabled === true || entry.status === 'disabled';

      const cpaStatus = statusHintDisabled
        ? 'disabled'
        : statusHintRequiresReauth
          ? 'error'
          : entry.status || undefined;

      const updatedCreds: AccountCredentials = {
        authType: 'cpa',
        cpaAuthIndex: entry.auth_index,
        cpaName: entry.name,
        cpaProvider: entry.provider,
        cpaProjectId: entry.project_id || undefined,
        cpaAccountId: entry.id_token?.chatgpt_account_id || undefined,
        cpaStatus,
        email: entry.email || acc?.email,
        plan: planOf(entry) || acc?.plan,
      };

      if (isUnlinked) {
        matchedLink.state = 'linked';
        matchedLink.unlinkedAt = null;

        if (acc) {
          acc.isActive = true;
          if (statusHintRequiresReauth) {
            acc.lastStatus = 'reauth_required';
            acc.lastError =
              entry.status_message || 'Re-authentication required in CLIProxy';
          } else if (acc.lastStatus === 'not_configured') {
            acc.lastStatus = 'idle';
            acc.lastError = undefined;
          }
          accountUpserts.push({ ...acc });
        }
        credUpserts.push([matchedLink.accountId, updatedCreds]);
        actions.push({
          kind: 'relinked',
          accountId: matchedLink.accountId,
          cpaName: entry.name,
        });
      } else {
        const existingCred = existingCreds?.get(matchedLink.accountId);
        const statusChanged = !existingCred || existingCred.cpaStatus !== cpaStatus;
        let changed = wasRenamedOrReindexed || statusChanged;
        if (acc) {
          if (statusHintRequiresReauth && acc.lastStatus !== 'reauth_required') {
            acc.lastStatus = 'reauth_required';
            acc.lastError =
              entry.status_message || 'Re-authentication required in CLIProxy';
            accountUpserts.push({ ...acc });
            changed = true;
          } else if (
            !statusHintRequiresReauth &&
            acc.lastStatus === 'reauth_required' &&
            statusChanged
          ) {
            acc.lastStatus = 'idle';
            acc.lastError = undefined;
            accountUpserts.push({ ...acc });
            changed = true;
          }
        }
        if (changed) {
          credUpserts.push([matchedLink.accountId, updatedCreds]);
          actions.push({
            kind: 'updated',
            accountId: matchedLink.accountId,
            cpaName: entry.name,
          });
        }
      }
      continue;
    }

    // Step 3b: Adopt existing native account if adoptExisting is true
    const trackerProvider = cpaToTrackerProvider(entry.provider);
    let adoptedAccount: ServerAccount | undefined;

    if (opts.adoptExisting && entry.email) {
      const entryEmailLower = entry.email.toLowerCase().trim();
      adoptedAccount = currentAccounts.find((a) => {
        if (seen.has(a.id)) return false;
        if (currentLinks.some((l) => l.accountId === a.id)) return false;
        if (a.providerType !== trackerProvider) return false;
        if (!a.email) return false;
        return a.email.toLowerCase().trim() === entryEmailLower;
      });
    }

    if (adoptedAccount) {
      seen.add(adoptedAccount.id);
      matchedLinkAccountIds.add(adoptedAccount.id);

      // Avoid duplicate identityKey across links
      if (seenIdentityKeys.has(entryIdentityKey)) {
        entryIdentityKey = `${entryIdentityKey}:${entry.name.toLowerCase().trim()}`;
      }
      seenIdentityKeys.add(entryIdentityKey);

      const statusHintRequiresReauth =
        entry.requires_sign_in === true || entry.status === 'error';
      const statusHintDisabled = entry.disabled === true || entry.status === 'disabled';

      const cpaStatus = statusHintDisabled
        ? 'disabled'
        : statusHintRequiresReauth
          ? 'error'
          : entry.status || undefined;

      const newLink: CpaLink = {
        accountId: adoptedAccount.id,
        identityKey: entryIdentityKey,
        cpaName: entry.name,
        authIndex: entry.auth_index,
        state: 'linked',
        lastSeenAt: now,
        unlinkedAt: null,
        routingJson: null,
      };
      currentLinks.push(newLink);

      // Clean credentials: clear native tokens, preserve identity and history
      const cpaCreds: AccountCredentials = {
        authType: 'cpa',
        cpaAuthIndex: entry.auth_index,
        cpaName: entry.name,
        cpaProvider: entry.provider,
        cpaProjectId: entry.project_id || undefined,
        cpaAccountId: entry.id_token?.chatgpt_account_id || undefined,
        cpaStatus,
        email: adoptedAccount.email || entry.email,
        plan: adoptedAccount.plan || planOf(entry),
      };

      adoptedAccount.isActive = true;
      if (statusHintRequiresReauth) {
        adoptedAccount.lastStatus = 'reauth_required';
        adoptedAccount.lastError =
          entry.status_message || 'Re-authentication required in CLIProxy';
      }

      accountUpserts.push({ ...adoptedAccount });
      credUpserts.push([adoptedAccount.id, cpaCreds]);
      actions.push({
        kind: 'adopted',
        accountId: adoptedAccount.id,
        cpaName: entry.name,
      });
      continue;
    }

    // Step 4: Create new account
    let newId = `cpa-${entry.auth_index}`;
    let counter = 1;
    while (
      currentAccounts.some((a) => a.id === newId) ||
      accountUpserts.some((a) => a.id === newId)
    ) {
      newId = `cpa-${entry.auth_index}-${++counter}`;
    }

    seen.add(newId);
    matchedLinkAccountIds.add(newId);

    // Avoid duplicate identityKey across links
    if (seenIdentityKeys.has(entryIdentityKey)) {
      entryIdentityKey = `${entryIdentityKey}:${entry.name.toLowerCase().trim()}`;
    }
    seenIdentityKeys.add(entryIdentityKey);

    const statusHintRequiresReauth =
      entry.requires_sign_in === true || entry.status === 'error';
    const statusHintDisabled = entry.disabled === true || entry.status === 'disabled';

    const cpaStatus = statusHintDisabled
      ? 'disabled'
      : statusHintRequiresReauth
        ? 'error'
        : entry.status || undefined;

    const newLink: CpaLink = {
      accountId: newId,
      identityKey: entryIdentityKey,
      cpaName: entry.name,
      authIndex: entry.auth_index,
      state: 'linked',
      lastSeenAt: now,
      unlinkedAt: null,
      routingJson: null,
    };
    currentLinks.push(newLink);

    const newCreds: AccountCredentials = {
      authType: 'cpa',
      cpaAuthIndex: entry.auth_index,
      cpaName: entry.name,
      cpaProvider: entry.provider,
      cpaProjectId: entry.project_id || undefined,
      cpaAccountId: entry.id_token?.chatgpt_account_id || undefined,
      cpaStatus,
      email: entry.email || undefined,
      plan: planOf(entry) || undefined,
    };

    const newAccount: ServerAccount = {
      id: newId,
      name: entry.label || entry.email || entry.name,
      providerType: trackerProvider,
      plan: planOf(entry),
      email: entry.email || undefined,
      orderIndex: ++maxOrderIndex,
      isActive: true,
      lastSyncAt: undefined,
      lastStatus: statusHintRequiresReauth ? 'reauth_required' : 'idle',
      lastError: statusHintRequiresReauth
        ? entry.status_message || 'Re-authentication required in CLIProxy'
        : undefined,
      createdAt: new Date(now).toISOString(),
      latestSnapshot: undefined,
    };

    currentAccounts.push(newAccount);
    accountUpserts.push(newAccount);
    credUpserts.push([newId, newCreds]);
    actions.push({
      kind: 'created',
      accountId: newId,
      cpaName: entry.name,
    });
  }

  // Unlinking logic per §3.4:
  // Only unlink if list succeeded with non-empty entries OR after 3 consecutive successful empty lists (emptyStreak >= 3)
  const canUnlink = filteredEntries.length > 0 || opts.emptyStreak >= 3;

  if (canUnlink) {
    for (const link of currentLinks) {
      if (link.state === 'linked' && !seen.has(link.accountId)) {
        link.state = 'unlinked';
        link.unlinkedAt = now;
        actions.push({
          kind: 'unlinked',
          accountId: link.accountId,
          cpaName: link.cpaName,
        });

        const acc = currentAccounts.find((a) => a.id === link.accountId);
        if (acc) {
          acc.isActive = false;
          acc.lastStatus = 'not_configured';
          acc.lastError = 'Credential no longer present in CLIProxy';
          if (acc.latestSnapshot) {
            acc.latestSnapshot = {
              ...acc.latestSnapshot,
              status: 'not_configured',
              errorMessage: acc.lastError,
            };
          }
          accountUpserts.push({ ...acc });
        }
      }
    }
  }

  // Purge logic per §3.4:
  // Purge unlinked accounts after purgeDays (default 30)
  const purgeMs = (opts.purgeDays ?? 30) * 86400 * 1000;
  const survivingLinks: CpaLink[] = [];

  for (const link of currentLinks) {
    if (
      link.state === 'unlinked' &&
      link.unlinkedAt != null &&
      now - link.unlinkedAt > purgeMs
    ) {
      deletes.push(link.accountId);
      actions.push({
        kind: 'purged',
        accountId: link.accountId,
        cpaName: link.cpaName,
      });
    } else {
      survivingLinks.push(link);
    }
  }

  return {
    actions,
    links: survivingLinks,
    accountUpserts,
    credUpserts,
    deletes,
  };
}
