import React, { useEffect, useState } from 'react';
import type { ProviderType } from '../../../../src/models/types';
import { PROVIDER_COMPANY, PROVIDER_NAMES } from '../../../../src/constants/theme';
import { api, type Account } from '../../api';
import { go, href } from '../../route';
import { Logo } from '../common/Logo';

/* Adds accounts that FQD signs in to itself (for setups without CLIProxy), or signs one in again. */

const DEFAULT_GUIDE = {
  steps: [
    'Open the service website on your computer and sign in to the account you want.',
    'DevTools (F12) → Network → find the request that returns your limits.',
    'Right-click → Copy → Copy as cURL and paste it here.',
  ],
  placeholder: 'curl …',
};

const GUIDES: Partial<Record<ProviderType, { steps: string[]; placeholder: string }>> = {
  antigravity: {
    steps: [
      'Recommended: use "Sign in to account" instead.',
      'Otherwise paste a Google OAuth refresh token (starts with 1//) for the Google account you use in Antigravity.',
      'You can also paste a JSON file that contains "refresh_token".',
    ],
    placeholder: '1//0g…  or  {"refresh_token":"1//…"}',
  },
  claude: {
    steps: [
      'Open claude.ai on your computer and sign in to the account you want.',
      'DevTools (F12) → Application → Cookies → https://claude.ai.',
      'Copy the sessionKey cookie value (starts with sk-ant-sid…). You can also paste a full cURL: Network → any request to /api → Copy as cURL.',
    ],
    placeholder: 'sk-ant-sid01-…  or  curl …',
  },
  chatgpt: {
    steps: [
      'Open chatgpt.com on your computer and sign in to the account you want.',
      'DevTools (F12) → Network → any request to backend-api → Copy as cURL.',
      'Paste the cURL here — the server will take the session cookie and refresh access automatically.',
    ],
    placeholder: 'curl https://chatgpt.com/backend-api/…',
  },
  gemini: {
    steps: [
      'Open gemini.google.com on your computer and sign in to the Google account you want.',
      'DevTools (F12) → Network → send any message → batchexecute request → Copy as cURL.',
      'For a second Google account, use a separate browser profile.',
    ],
    placeholder: "curl 'https://gemini.google.com/_/BardChatUi/data/batchexecute…",
  },
  cursor: {
    steps: ['Open cursor.com/settings and sign in.', 'DevTools → Network → usage request → Copy as cURL.', 'Paste it here.'],
    placeholder: 'curl https://cursor.com/api/usage …',
  },
  custom: {
    steps: [
      'Open the service website and find the page with limits/quota.',
      'DevTools → Network → the request that returns limits → Copy as cURL.',
      'Paste it — the server will find the percentages and reset time in the response.',
    ],
    placeholder: 'curl … (any service)',
  },
};

const ADD_GROUPS: Array<{ title: string; items: ProviderType[] }> = [
  { title: 'Main', items: ['claude', 'chatgpt', 'gemini'] },
  { title: 'Coding', items: ['antigravity', 'cursor', 'copilot'] },
  { title: 'Chat assistants', items: ['perplexity', 'grok', 'mistral', 'deepseek', 'poe'] },
  { title: 'Any other service', items: ['custom'] },
];

const supportsOAuth = (p: ProviderType) => p === 'claude' || p === 'chatgpt' || p === 'antigravity';

const CALLBACK_HINT: Partial<Record<ProviderType, string>> = {
  chatgpt: 'localhost:1455/auth/callback?code=…',
  antigravity: 'localhost:51121/oauth-callback?code=…',
};

export const AddAccount: React.FC<{ accounts: Account[]; reload: () => Promise<void>; reconnectId?: string }> = ({ accounts, reload, reconnectId }) => {
  const reconnect = accounts.find((a) => a.id === reconnectId);
  const [provider, setProvider] = useState<ProviderType | null>(reconnect?.providerType ?? null);
  const [mode, setMode] = useState<'oauth' | 'manual'>('oauth');
  const [oauth, setOauth] = useState<{ authorizeUrl: string; state: string } | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    setInput('');
    setErr('');
    setOauth(null);
    setMode(provider && supportsOAuth(provider) ? 'oauth' : 'manual');
  }, [provider]);

  const startOAuth = async () => {
    if (!provider) return;
    setErr('');
    try {
      const r = await api.oauthStart(provider, reconnect?.id);
      setOauth(r);
      window.open(r.authorizeUrl, '_blank', 'noopener');
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const submit = async () => {
    if (!provider) return;
    setBusy(true);
    setErr('');
    try {
      if (mode === 'oauth' && oauth) await api.oauthFinish(oauth.state, input);
      else await api.manual(provider, input, reconnect?.id);
      await reload();
      go('accounts');
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const back = <a className="link" href={href('accounts')}>Back to Accounts</a>;

  if (!provider) {
    return (
      <div className="card add-page">
        {back}
        <h2 style={{ marginTop: 10 }}>Add account</h2>
        <p className="muted small" style={{ marginTop: 0 }}>For accounts that CLIProxy does not serve. FQD signs in and checks their quota itself.</p>
        <div style={{ display: 'grid', gap: 16 }}>
          {ADD_GROUPS.map((g) => (
            <div key={g.title}>
              <div className="group-title">{g.title}</div>
              <div style={{ display: 'grid', gap: 8 }}>
                {g.items.map((p) => (
                  <button key={p} className="provider-pick" onClick={() => setProvider(p)}>
                    <Logo type={p} size={36} />
                    <div>
                      <div style={{ fontWeight: 600 }}>{PROVIDER_NAMES[p]}</div>
                      <div className="muted small">{PROVIDER_COMPANY[p]}</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const guide = GUIDES[provider] || DEFAULT_GUIDE;
  const codePlaceholder = provider === 'claude' ? 'code#state' : `http://${CALLBACK_HINT[provider] ?? CALLBACK_HINT.chatgpt}`;

  return (
    <div className="card add-page">
      {back}
      <h2 style={{ marginTop: 10 }}>{reconnect ? `Reconnect ${reconnect.name}` : `Connect ${PROVIDER_NAMES[provider]}`}</h2>
      <p className="muted small" style={{ marginTop: 0 }}>
        {reconnect ? 'Sign in again to update the stored credentials.' : `Add a ${PROVIDER_COMPANY[provider]} account`}
      </p>

      {supportsOAuth(provider) && (
        <div className="seg-group" style={{ marginBottom: 16 }}>
          <button className={mode === 'oauth' ? 'on' : ''} onClick={() => setMode('oauth')}>Sign in (recommended)</button>
          <button className={mode === 'manual' ? 'on' : ''} onClick={() => setMode('manual')}>Token or cookie</button>
        </div>
      )}

      {mode === 'oauth' ? (
        <div style={{ display: 'grid', gap: 12 }}>
          <p className="muted small" style={{ margin: 0 }}>Sign in through the provider to grant quota monitoring access.</p>
          {!oauth ? (
            <button className="btn primary" onClick={startOAuth}>Sign in to account</button>
          ) : (
            <>
              <div className="banner ok">A sign-in window opened. After authorizing, paste the callback URL or code here.</div>
              <input className="form-input" value={input} onChange={(e) => setInput(e.target.value)} placeholder={codePlaceholder} aria-label="Callback URL or code" />
              <button className="btn primary" disabled={busy || !input.trim()} onClick={submit}>{busy ? 'Connecting…' : 'Finish'}</button>
            </>
          )}
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          <div className="small muted">
            <ol style={{ paddingLeft: 18, margin: 0 }}>
              {guide.steps.map((s, i) => (
                <li key={i} style={{ marginBottom: 4 }}>{s}</li>
              ))}
            </ol>
          </div>
          <textarea
            className="form-input"
            rows={4}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={guide.placeholder}
            aria-label="Token, cookie or cURL"
            style={{ fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12 }}
          />
          <button className="btn primary" disabled={busy || !input.trim()} onClick={submit}>{busy ? 'Validating…' : 'Save account'}</button>
        </div>
      )}

      {err && <div className="banner danger" style={{ marginTop: 12 }}>{err}</div>}
    </div>
  );
};
