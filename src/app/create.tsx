import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { ChevronRight, Info } from 'lucide-react-native';
import { AccountLoginSheet } from '../components/AccountLoginSheet';
import { ProviderLogo } from '../components/ProviderLogo';
import { Card, ScreenHeader } from '../components/ui';
import { Colors, PROVIDER_COMPANY, PROVIDER_NAMES, Radius } from '../constants/theme';
import { ProviderType } from '../models/types';
import { useAppStore } from '../store/useAppStore';

const GROUPS: Array<{ title: string; items: Array<{ type: ProviderType; note: string }> }> = [
  {
    title: 'Essentials',
    items: [
      { type: 'claude', note: '5-hour session, weekly, Opus/Sonnet, extra usage' },
      { type: 'chatgpt', note: 'Codex 5-hour and weekly limits, credits' },
      { type: 'gemini', note: 'Session and weekly (via cURL)' },
    ],
  },
  {
    title: 'Coding',
    items: [
      { type: 'cursor', note: 'Premium (fast) requests' },
      { type: 'copilot', note: 'Premium requests per month' },
    ],
  },
  {
    title: 'Chat assistants',
    items: [
      { type: 'perplexity', note: 'Pro requests' },
      { type: 'grok', note: 'Request window' },
      { type: 'mistral', note: 'Le Chat' },
      { type: 'deepseek', note: 'Account limits' },
      { type: 'poe', note: 'Compute points' },
    ],
  },
  {
    title: 'Any other service',
    items: [{ type: 'custom', note: 'Paste a cURL request — limits are detected automatically' }],
  },
];

export default function AddAccountScreen() {
  const router = useRouter();
  const accounts = useAppStore((s) => s.accounts);
  const [provider, setProvider] = useState<ProviderType | null>(null);

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right', 'bottom']}>
      <ScrollView contentContainerStyle={styles.content}>
        <ScreenHeader title="Add account" />

        {GROUPS.map((group) => (
          <View key={group.title}>
            <Text style={styles.groupTitle}>{group.title}</Text>
            {group.items.map(({ type, note }) => {
              const existing = accounts.filter((a) => a.providerType === type).length;
              return (
                <Card key={type} style={styles.row} onPress={() => setProvider(type)}>
                  <ProviderLogo type={type} size={42} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.name}>{PROVIDER_NAMES[type]}</Text>
                    <Text style={styles.company}>{PROVIDER_COMPANY[type]}</Text>
                    <Text style={styles.note}>{note}</Text>
                  </View>
                  {existing > 0 && (
                    <View style={styles.badge}>
                      <Text style={styles.badgeText}>+{existing === 1 ? '2nd' : `${existing + 1}th`}</Text>
                    </View>
                  )}
                  <ChevronRight size={20} color={Colors.textMuted} />
                </Card>
              );
            })}
          </View>
        ))}

        <View style={styles.info}>
          <Info size={16} color={Colors.textMuted} />
          <Text style={styles.infoText}>
            You can connect any number of accounts for the same service — for example, two Claude and two ChatGPT.
            Each sign-in opens in a clean session and gets its own token, so accounts do not interfere with each
            other and refresh independently in the background. The same account cannot be connected twice.
          </Text>
        </View>
      </ScrollView>

      {provider && (
        <AccountLoginSheet
          visible
          providerType={provider}
          onClose={() => setProvider(null)}
          onConnected={(id) => router.replace({ pathname: '/account/[id]', params: { id } })}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  content: {
    paddingHorizontal: 18,
    paddingBottom: 30,
  },
  groupTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: Colors.textMuted,
    marginTop: 18,
    marginBottom: 10,
    letterSpacing: 0.2,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    marginBottom: 12,
  },
  name: {
    fontSize: 16,
    fontWeight: '700',
    color: Colors.text,
  },
  company: {
    fontSize: 12.5,
    color: Colors.textMuted,
    marginTop: 1,
  },
  note: {
    fontSize: 11.5,
    color: Colors.textSubtle,
    marginTop: 4,
  },
  badge: {
    backgroundColor: Colors.cardHighlight,
    borderRadius: Radius.full,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '600',
    color: Colors.textMuted,
  },
  info: {
    flexDirection: 'row',
    gap: 10,
    padding: 14,
    marginTop: 8,
    borderRadius: Radius.lg,
    backgroundColor: Colors.cardHighlight,
  },
  infoText: {
    flex: 1,
    fontSize: 12.5,
    lineHeight: 18,
    color: Colors.textMuted,
  },
});
