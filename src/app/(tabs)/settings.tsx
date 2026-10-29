import React, { useEffect, useState } from 'react';
import { Alert, ScrollView, Share, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Bell, Download, History, Palette, RefreshCw, Shield, Trash2, User } from 'lucide-react-native';
import { Card, MenuRow, ScreenHeader } from '../../components/ui';
import { Colors, Radius } from '../../constants/theme';
import { useAppStore } from '../../store/useAppStore';
import { formatRelative, plural } from '../../utils/formatters';

const INTERVALS = [5, 15, 30, 60];

export default function SettingsScreen() {
  const router = useRouter();
  const {
    accounts,
    snapshots,
    refreshIntervalMin,
    setRefreshInterval,
    deleteAllAccounts,
    userName,
    setUserName,
    lastSyncAllAt,
  } = useAppStore();
  const [name, setName] = useState(userName);
  useEffect(() => setName(userName), [userName]);

  const pickInterval = () =>
    Alert.alert('Data refresh', 'How often to refresh limits while the app is open', [
      ...INTERVALS.map((m) => ({
        text: `${m === refreshIntervalMin ? '✓ ' : ''}Every ${m} ${plural(m, ['minute', 'minutes', 'minutes'])}`,
        onPress: () => setRefreshInterval(m),
      })),
      { text: 'Cancel', style: 'cancel' as const },
    ]);

  const exportData = async () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      accounts: accounts.map((a) => ({
        name: a.name,
        provider: a.providerType,
        plan: a.plan,
        email: a.email,
        status: a.lastStatus,
        lastSyncAt: a.lastSyncAt,
        limits: (snapshots[a.id]?.buckets || []).map((b) => ({
          label: b.label,
          usedPercent: b.utilizationPercent,
          resetsAt: b.resetsAt,
        })),
      })),
    };
    try {
      await Share.share({ message: JSON.stringify(payload, null, 2), title: 'AI Limits — export' });
    } catch {}
  };

  const deleteAll = () =>
    Alert.alert('Delete all accounts?', 'Tokens, cookies, and history for all accounts will be removed from this device.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete all', style: 'destructive', onPress: () => deleteAllAccounts() },
    ]);

  const privacy = () =>
    Alert.alert(
      'Privacy',
      'Tokens and cookies are stored only on this device in secure storage (Keychain / Keystore). ' +
        'Requests go directly to Anthropic, OpenAI, and Google servers — with no third-party servers. ' +
        'Each account is isolated: its data is never sent together with another account\'s data.'
    );

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <ScreenHeader large title="Settings" subtitle={`Last refresh: ${formatRelative(lastSyncAllAt)}`} />

        <Card style={styles.nameCard}>
          <User size={18} color={Colors.textMuted} />
          <TextInput
            style={styles.nameInput}
            value={name}
            onChangeText={setName}
            onBlur={() => name !== userName && setUserName(name)}
            onSubmitEditing={() => setUserName(name)}
            placeholder="Your name for the greeting"
            placeholderTextColor={Colors.textSubtle}
            returnKeyType="done"
          />
        </Card>

        <Card style={styles.menu}>
          <MenuRow icon={<Palette size={18} color={Colors.textMuted} />} title="Appearance" value="Light theme" onPress={() => {}} />
          <MenuRow
            icon={<RefreshCw size={18} color={Colors.textMuted} />}
            title="Data refresh"
            value={`Every ${refreshIntervalMin} min`}
            onPress={pickInterval}
          />
          <MenuRow icon={<Bell size={18} color={Colors.textMuted} />} title="Notifications" onPress={() => router.push('/notifications')} />
          <MenuRow icon={<History size={18} color={Colors.textMuted} />} title="Usage history" onPress={() => router.push('/history')} />
          <MenuRow icon={<Shield size={18} color={Colors.textMuted} />} title="Privacy" onPress={privacy} />
          <MenuRow icon={<Download size={18} color={Colors.textMuted} />} title="Export data" onPress={exportData} />
          <MenuRow
            icon={<Trash2 size={18} color={Colors.exhausted} />}
            title="Delete all accounts"
            danger
            onPress={deleteAll}
            last
          />
        </Card>

        <Text style={styles.footer}>
          AI Limits Tracker · {accounts.length} {plural(accounts.length, ['account', 'accounts', 'accounts'])}
        </Text>
      </ScrollView>
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
  nameCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 6,
    marginBottom: 12,
  },
  nameInput: {
    flex: 1,
    fontSize: 14.5,
    color: Colors.text,
    paddingVertical: 10,
  },
  menu: {
    paddingVertical: 0,
    borderRadius: Radius.xl,
  },
  footer: {
    fontSize: 11.5,
    color: Colors.textSubtle,
    textAlign: 'center',
    marginTop: 18,
  },
});
