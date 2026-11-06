import type { Store } from './store';
import type { LinkRoutingState } from '../../src/services/cpa/types';

export type HoldOwner = 'none' | 'fqd' | 'operator' | 'external';

/** Pure. Reads recorded provenance only; never infers. */
export function holdOwnerOf(input: {
  disabled: boolean; // the caller's best view of CLIProxy's disabled flag
  routing: LinkRoutingState | null;
  activeHold: boolean; // store.getManualHold(accountId, now) !== null
}): HoldOwner {
  if (!input.disabled) {
    return 'none';
  }
  if (input.activeHold) {
    return 'operator';
  }
  const routing = input.routing;
  if (
    routing &&
    (routing.disabledBy === 'policy' || routing.disabledBy === 'reactive_429') &&
    routing.managed !== false
  ) {
    return 'fqd';
  }
  return 'external';
}

/** Store-backed convenience for the tracker and the watcher: disabled = creds.cpaStatus === 'disabled'. */
export function holdOwner(store: Store, accountId: string, now?: number): HoldOwner {
  const currentNow = now ?? Date.now();
  const creds = store.getCredentials(accountId);
  const disabled = creds?.cpaStatus === 'disabled';
  const routing = store.getCpaLinkRouting(accountId);
  const activeHold = store.getManualHold(accountId, currentNow) !== null;
  return holdOwnerOf({ disabled, routing, activeHold });
}
