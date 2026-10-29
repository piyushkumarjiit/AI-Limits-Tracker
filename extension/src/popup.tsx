import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ProviderType } from '../../src/models/types';
import { PROVIDER_NAMES, remainingColor } from '../../src/constants/theme';
import { headlineBucket } from '../../src/services/providers/common';
import { formatTimeRemaining } from '../../src/utils/formatters';
import { loadStore, PROVIDERS, setEnabled, syncProvider, TrackedAccount, updateBadge } from './core';
import { Logo, Ring } from './widgets';
import './popup.css';

const PANEL_URL = 'https://github.com/piyushkumarjiit/AI-Limits-Tracker#web-panel';

function App() {
  const [accounts, setAccounts] = useState<Partial<Record<ProviderType, TrackedAccount>>>({});
  const [busy, setBusy] = useState(true);

  const reload = async () => setAccounts((await loadStore()).accounts);

  useEffect(() => {
    (async () => {
      await reload();
      setBusy(true);
      await Promise.allSettled(PROVIDERS.map((p) => syncProvider(p)));
      await updateBadge();
      await reload();
      setBusy(false);
    })();
  }, []);

  const refresh = async () => {
    setBusy(true);
    await Promise.allSettled(PROVIDERS.map((p) => syncProvider(p)));
    await updateBadge();
    await reload();
    setBusy(false);
  };

  const toggle = async (p: ProviderType, enabled: boolean) => {
    await setEnabled(p, enabled);
    if (enabled) await syncProvider(p);
    await updateBadge();
    await reload();
  };

  return (
    <div className="popup">
      <header>
        <div className="brand"><span>◔</span> AI Limits</div>
        <button className={`refresh ${busy ? 'spin' : ''}`} onClick={refresh} aria-label="Refresh">↻</button>
      </header>

      <div className="list">
        {PROVIDERS.map((p) => {
          const acc = accounts[p];
          const b = headlineBucket(acc?.snapshot);
          const enabled = acc?.enabled !== false;
          return (
            <div key={p} className={`row ${enabled ? '' : 'off'}`}>
              <Logo type={p} size={36} />
              <div className="meta">
                <b>{PROVIDER_NAMES[p]}</b>
                {!enabled ? (
                  <span className="muted">Off</span>
                ) : acc?.status === 'ok' ? (
                  <span className="muted">{[acc.plan, acc.email].filter(Boolean).join(' · ') || 'Active'}</span>
                ) : acc?.status === 'reauth' ? (
                  <span className="warn">Sign in to {p === 'claude' ? 'claude.ai' : p === 'chatgpt' ? 'chatgpt.com' : 'the service'}</span>
                ) : acc?.status === 'error' ? (
                  <span className="muted">{acc.lastError}</span>
                ) : (
                  <span className="muted">Checking…</span>
                )}
              </div>
              {enabled && acc?.status === 'ok' && b ? (
                <div className="right">
                  <Ring remaining={b.remainingPercent} size={40} stroke={5} color={remainingColor(b.remainingPercent, p)} />
                  <span className="reset">{formatTimeRemaining(b.resetsAt)}</span>
                </div>
              ) : (
                <label className="switch">
                  <input type="checkbox" checked={enabled} onChange={(e) => toggle(p, e.target.checked)} />
                  <i />
                </label>
              )}
            </div>
          );
        })}
      </div>

      <footer>
        <span>One account per browser profile</span>
        <a href={PANEL_URL} target="_blank" rel="noopener">Need more? Open the web panel →</a>
      </footer>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
