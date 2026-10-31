import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView, WebViewNavigation } from 'react-native-webview';
import { CheckCircle2, ChevronLeft, KeyRound, RotateCcw, ShieldCheck, XCircle } from 'lucide-react-native';
import { Colors, PROVIDER_NAMES, Radius } from '../constants/theme';
import { AccountCredentials, AccountEntity, ProviderType } from '../models/types';
import { parseManualInput } from '../services/curlParser';
import { buildAntigravityAuthorizeUrl, exchangeAntigravityCode, isAntigravityCallbackUrl } from '../services/oauth/antigravityOAuth';
import { buildChatGPTAuthorizeUrl, exchangeChatGPTCode, isChatGPTCallbackUrl } from '../services/oauth/chatgptOAuth';
import { buildClaudeAuthorizeUrl, exchangeClaudeCode, isClaudeCallbackUrl } from '../services/oauth/claudeOAuth';
import { parseAuthCode } from '../services/oauth/authCode';
import { createPkcePair, PkcePair } from '../services/oauth/pkce';
import { useAppStore } from '../store/useAppStore';
import { ProviderLogo } from './ProviderLogo';
import { PrimaryButton, Segmented } from './ui';

// Google blocks sign-in inside embedded browsers with the default WebView UA
const SAFARI_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

type Phase = 'login' | 'exchanging' | 'success' | 'error';
type Mode = 'oauth' | 'manual';

interface Props {
  visible: boolean;
  providerType: ProviderType;
  /** When set, the login re-binds this account instead of creating a new one. */
  account?: AccountEntity | null;
  onClose: () => void;
  onConnected?: (accountId: string) => void;
}

const supportsOAuth = (p: ProviderType) => p === 'claude' || p === 'chatgpt' || p === 'antigravity';

const MANUAL_HINTS: Partial<Record<ProviderType, string>> = {
  antigravity:
    'Paste a Google refresh token (starts with 1//) for the account you use in Antigravity, or the JSON that contains it. Sign-in with Google is recommended instead.',
  claude:
    'Open claude.ai in a desktop browser → DevTools → Application → Cookies → copy the sessionKey value. Or go to Network → any request to /api → Copy as cURL.',
  chatgpt:
    'Open chatgpt.com/api/auth/session in a browser and copy the accessToken, or go to Network → a backend-api request → Copy as cURL.',
  gemini:
    'Open gemini.google.com on a computer → DevTools → Network → any batchexecute request → Copy as cURL. Each Google account needs its own cURL (from a separate browser profile).',
  cursor:
    'Open cursor.com/settings → DevTools → Network → a usage request → Copy as cURL.',
  copilot:
    'Open github.com (with Copilot active) → DevTools → Network → Copy as cURL for a Copilot request, or paste a token.',
  perplexity:
    'Open perplexity.ai → DevTools → Network → a request to rest/user → Copy as cURL.',
  grok:
    'Open grok.com → DevTools → Network → a rate-limits request → Copy as cURL.',
  mistral: 'Open chat.mistral.ai → DevTools → Network → Copy as cURL for a request that includes your limits.',
  deepseek: 'Open chat.deepseek.com → DevTools → Network → Copy as cURL for a profile/limits request.',
  poe: 'Open poe.com → DevTools → Network → a gql_POST (settings) request → Copy as cURL.',
  custom:
    'Paste the cURL for a request that returns your limits on the service\'s website (DevTools → Network → Copy as cURL). The app will find the percentages and reset time in the response automatically.',
};
const DEFAULT_HINT = 'Paste the cURL for a service request that returns your limits.';

export const AccountLoginSheet: React.FC<Props> = ({ visible, providerType, account, onClose, onConnected }) => {
  const connectAccount = useAppStore((s) => s.connectAccount);
  const [mode, setMode] = useState<Mode>(supportsOAuth(providerType) ? 'oauth' : 'manual');
  const [phase, setPhase] = useState<Phase>('login');
  const [message, setMessage] = useState<string>('');
  const [pkce, setPkce] = useState<PkcePair | null>(null);
  const [webKey, setWebKey] = useState(0);
  const [pageLoading, setPageLoading] = useState(true);
  const [manualText, setManualText] = useState('');
  const [codeText, setCodeText] = useState('');
  const [showCodeInput, setShowCodeInput] = useState(false);
  const handledRef = useRef(false);

  const reset = useCallback(async () => {
    handledRef.current = false;
    setPhase('login');
    setMessage('');
    setCodeText('');
    setShowCodeInput(Platform.OS === 'web');
    setPageLoading(true);
    if (supportsOAuth(providerType)) {
      setPkce(await createPkcePair());
      setWebKey((k) => k + 1);
    }
  }, [providerType]);

  useEffect(() => {
    if (visible) {
      setMode(supportsOAuth(providerType) ? 'oauth' : 'manual');
      setManualText('');
      reset();
    }
  }, [visible, providerType, reset]);

  const authorizeUrl = pkce
    ? providerType === 'claude'
      ? buildClaudeAuthorizeUrl(pkce.challenge, pkce.state)
      : providerType === 'antigravity'
      ? buildAntigravityAuthorizeUrl(pkce.challenge, pkce.state)
      : buildChatGPTAuthorizeUrl(pkce.challenge, pkce.state)
    : null;

  const finish = async (creds: AccountCredentials) => {
    const result = await connectAccount(providerType, creds, account?.id);
    if (!result.ok) {
      setPhase('error');
      setMessage(result.error);
      return;
    }
    setPhase('success');
    const who = result.snapshot.email ? ` (${result.snapshot.email})` : '';
    setMessage(`Account connected${who}`);
    setTimeout(() => {
      onConnected?.(result.accountId);
      onClose();
    }, 900);
  };

  const handleAuthCode = async (raw: string) => {
    if (!pkce || handledRef.current) return;
    const parsed = parseAuthCode(raw);
    if (!parsed) {
      setPhase('error');
      setMessage('Could not read the authorization code');
      return;
    }
    if (parsed.state && parsed.state !== pkce.state) {
      setPhase('error');
      setMessage('This code belongs to a different sign-in attempt. Start over.');
      return;
    }
    handledRef.current = true;
    setPhase('exchanging');
    setMessage('Getting tokens…');
    try {
      const creds =
        providerType === 'claude'
          ? await exchangeClaudeCode(parsed.code, parsed.state, pkce.verifier, pkce.state)
          : providerType === 'antigravity'
          ? await exchangeAntigravityCode(parsed.code, pkce.verifier)
          : await exchangeChatGPTCode(parsed.code, pkce.verifier);
      setMessage('Verifying the account and loading limits…');
      await finish(creds);
    } catch (e: any) {
      setPhase('error');
      setMessage(e?.message || 'Could not complete sign-in');
    }
  };

  const isCallback = (url: string) =>
    providerType === 'claude'
      ? isClaudeCallbackUrl(url)
      : providerType === 'antigravity'
      ? isAntigravityCallbackUrl(url)
      : isChatGPTCallbackUrl(url);

  const handleManualSave = async () => {
    const parsed = parseManualInput(manualText, providerType);
    if (!parsed.ok) {
      setPhase('error');
      setMessage(parsed.error);
      return;
    }
    setPhase('exchanging');
    setMessage('Verifying credentials and loading limits…');
    await finish(parsed.credentials);
  };

  const title = account ? `Reconnect: ${account.name}` : `Sign in to ${PROVIDER_NAMES[providerType]}`;

  const renderStatus = () => {
    if (phase === 'login' || !message) return null;
    const color =
      phase === 'error' ? Colors.exhausted : phase === 'success' ? Colors.normal : Colors.textMuted;
    return (
      <View style={[styles.statusBar, { borderColor: color }]}>
        {phase === 'exchanging' && <ActivityIndicator size="small" color={color} />}
        {phase === 'success' && <CheckCircle2 size={16} color={color} />}
        {phase === 'error' && <XCircle size={16} color={color} />}
        <Text style={[styles.statusText, { color }]}>{message}</Text>
        {phase === 'error' && (
          <TouchableOpacity onPress={reset} style={styles.retryBtn}>
            <RotateCcw size={13} color={Colors.text} />
            <Text style={styles.retryText}>Start over</Text>
          </TouchableOpacity>
        )}
      </View>
    );
  };

  const renderOAuth = () => (
    <View style={{ flex: 1 }}>
      <View style={styles.tip}>
        <ShieldCheck size={15} color={Colors.normal} />
        <Text style={styles.tipText}>
          Clean session: sign in to {account ? 'the required' : 'any'} {PROVIDER_NAMES[providerType]} account. Other
          connected accounts are not affected.
          {providerType === 'claude' ? ' After signing in, tap "Authorize".' : ''}
        </Text>
      </View>

      {providerType === 'antigravity' && (
        <Text style={styles.riskNote}>
          Antigravity limits are read from Google's internal Cloud Code service using Antigravity's own sign-in client. This is unofficial. AI-Limits-Tracker only reads your quota every few minutes and never sends prompts, but Google could change or restrict this at any time.
        </Text>
      )}

      {showCodeInput && (
        <View style={styles.codeBox}>
          {Platform.OS === 'web' && authorizeUrl && (
            <PrimaryButton
              label="Open sign-in page"
              onPress={() => Linking.openURL(authorizeUrl)}
              style={{ marginBottom: 10 }}
            />
          )}
          <Text style={styles.codeLabel}>
            {providerType === 'claude'
              ? 'If the page shows a code, paste it here:'
              : providerType === 'antigravity'
              ? 'Paste the URL of the page you were redirected to (localhost:51121/…):'
              : 'Paste the URL of the page you were redirected to (localhost:1455/…):'}
          </Text>
          <View style={styles.codeRow}>
            <TextInput
              style={styles.codeInput}
              value={codeText}
              onChangeText={setCodeText}
              placeholder={
                providerType === 'claude'
                  ? 'code#state'
                  : providerType === 'antigravity'
                  ? 'http://localhost:51121/oauth-callback?code=…'
                  : 'http://localhost:1455/auth/callback?code=…'
              }
              placeholderTextColor={Colors.textSubtle}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <TouchableOpacity style={styles.codeBtn} onPress={() => handleAuthCode(codeText)}>
              <Text style={styles.codeBtnText}>OK</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {Platform.OS !== 'web' && authorizeUrl && (
        <View style={styles.webWrap}>
          <WebView
            key={webKey}
            source={{ uri: authorizeUrl }}
            incognito
            cacheEnabled={false}
            sharedCookiesEnabled={false}
            thirdPartyCookiesEnabled
            domStorageEnabled
            javaScriptEnabled
            setSupportMultipleWindows={false}
            javaScriptCanOpenWindowsAutomatically
            userAgent={SAFARI_USER_AGENT}
            originWhitelist={['*']}
            onShouldStartLoadWithRequest={(req) => {
              if (isCallback(req.url)) {
                handleAuthCode(req.url);
                return false;
              }
              return /^https?:/i.test(req.url);
            }}
            onNavigationStateChange={(nav: WebViewNavigation) => {
              setPageLoading(nav.loading);
              if (isCallback(nav.url)) handleAuthCode(nav.url);
            }}
            onLoadEnd={() => setPageLoading(false)}
            onError={(e) => {
              const url = e.nativeEvent.url || '';
              if (isCallback(url)) handleAuthCode(url);
            }}
            style={styles.webview}
          />
          {(pageLoading || phase === 'exchanging') && (
            <View style={styles.loader} pointerEvents="none">
              <ActivityIndicator size="large" color={Colors.text} />
            </View>
          )}
        </View>
      )}

      {!showCodeInput && Platform.OS !== 'web' && (
        <TouchableOpacity style={styles.linkBtn} onPress={() => setShowCodeInput(true)}>
          <KeyRound size={13} color={Colors.textMuted} />
          <Text style={styles.linkText}>Did the page show a code? Paste it manually</Text>
        </TouchableOpacity>
      )}
    </View>
  );

  const renderManual = () => (
    <ScrollView contentContainerStyle={{ paddingBottom: 30 }} keyboardShouldPersistTaps="handled">
      <View style={styles.manualHead}>
        <ProviderLogo type={providerType} size={44} />
        <Text style={styles.manualHint}>{MANUAL_HINTS[providerType] || DEFAULT_HINT}</Text>
      </View>
      <TextInput
        style={styles.manualInput}
        value={manualText}
        onChangeText={setManualText}
        placeholder={
          providerType === 'claude'
            ? 'sk-ant-sid01-… or curl …'
            : providerType === 'chatgpt'
            ? 'eyJhbGciOi… or curl …'
            : providerType === 'antigravity'
            ? '1//0g… or {"refresh_token":"1//…"}'
            : "curl 'https://gemini.google.com/_/BardChatUi/…"
        }
        placeholderTextColor={Colors.textSubtle}
        multiline
        autoCapitalize="none"
        autoCorrect={false}
        textAlignVertical="top"
      />
      <Text style={styles.manualNote}>
        Data is stored only on this device (Keychain / Keystore) and sent only to {' '}
        {PROVIDER_NAMES[providerType]}.
      </Text>
      <PrimaryButton
        label="Connect"
        onPress={handleManualSave}
        disabled={!manualText.trim() || phase === 'exchanging'}
      />
    </ScrollView>
  );

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} presentationStyle="fullScreen">
      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={styles.header}>
            <TouchableOpacity onPress={onClose} hitSlop={12}>
              <ChevronLeft size={24} color={Colors.text} />
            </TouchableOpacity>
            <Text style={styles.headerTitle} numberOfLines={1}>
              {title}
            </Text>
          </View>

          {supportsOAuth(providerType) && (
            <Segmented
              style={{ marginHorizontal: 16, marginBottom: 10 }}
              value={mode}
              onChange={(m) => {
                setMode(m);
                setPhase('login');
                setMessage('');
              }}
              options={[
                { key: 'oauth', label: 'Account sign-in' },
                { key: 'manual', label: 'Manual (cURL / token)' },
              ]}
            />
          )}

          {renderStatus()}

          <View style={{ flex: 1, paddingHorizontal: mode === 'manual' ? 16 : 0 }}>
            {mode === 'oauth' && supportsOAuth(providerType) ? renderOAuth() : renderManual()}
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
};

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: Colors.text,
    flex: 1,
  },
  tip: {
    flexDirection: 'row',
    gap: 8,
    marginHorizontal: 16,
    marginBottom: 10,
    padding: 12,
    borderRadius: Radius.md,
    backgroundColor: Colors.normalSoft,
  },
  tipText: {
    flex: 1,
    fontSize: 12,
    lineHeight: 17,
    color: '#166534',
  },
  riskNote: {
    fontSize: 11.5,
    color: Colors.textSubtle,
    lineHeight: 16,
    marginHorizontal: 16,
    marginBottom: 10,
  },
  statusBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginBottom: 10,
    padding: 12,
    borderRadius: Radius.md,
    borderWidth: 1,
    backgroundColor: Colors.card,
  },
  statusText: {
    flex: 1,
    fontSize: 13,
    fontWeight: '600',
    lineHeight: 18,
  },
  retryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: Radius.full,
    backgroundColor: Colors.cardHighlight,
  },
  retryText: {
    fontSize: 12,
    fontWeight: '600',
    color: Colors.text,
  },
  webWrap: {
    flex: 1,
    marginHorizontal: 12,
    borderRadius: Radius.lg,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: '#fff',
  },
  webview: {
    flex: 1,
    backgroundColor: '#fff',
  },
  loader: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(255,255,255,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  linkBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
  },
  linkText: {
    fontSize: 12,
    color: Colors.textMuted,
  },
  codeBox: {
    marginHorizontal: 16,
    marginBottom: 10,
  },
  codeLabel: {
    fontSize: 12,
    color: Colors.textMuted,
    marginBottom: 6,
  },
  codeRow: {
    flexDirection: 'row',
    gap: 8,
  },
  codeInput: {
    flex: 1,
    backgroundColor: Colors.cardElevated,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.sm,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 13,
    color: Colors.text,
  },
  codeBtn: {
    backgroundColor: Colors.ink,
    borderRadius: Radius.sm,
    paddingHorizontal: 16,
    justifyContent: 'center',
  },
  codeBtnText: {
    color: Colors.inkText,
    fontWeight: '700',
  },
  manualHead: {
    flexDirection: 'row',
    gap: 12,
    alignItems: 'flex-start',
    marginVertical: 12,
  },
  manualHint: {
    flex: 1,
    fontSize: 12.5,
    lineHeight: 18,
    color: Colors.textMuted,
  },
  manualInput: {
    minHeight: 160,
    backgroundColor: Colors.cardElevated,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.md,
    padding: 14,
    fontSize: 12.5,
    color: Colors.text,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  manualNote: {
    fontSize: 11.5,
    color: Colors.textSubtle,
    lineHeight: 16,
    marginVertical: 12,
  },
});
