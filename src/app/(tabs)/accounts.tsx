import React from 'react';
import { Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { ChevronRight, Plus, RefreshCw } from 'lucide-react-native';
import { ProviderLogo } from '../../components/ProviderLogo';
import { accountStatus, Card, EmptyState, PrimaryButton, ScreenHeader, StatusDot } from '../../components/ui';
import { Colors } from '../../constants/theme';
import { AccountEntity } from '../../models/types';
import { useAppStore } from '../../store/useAppStore';
import { formatRelative } from '../../utils/formatters';

export default function AccountsScreen() {
  const router = useRouter();
  const { accounts, snapshots, moveAccount, deleteAccount, refreshAll, isSyncing } = useAppStore();

  const openActions = (account: AccountEntity, index: number) => {
    const buttons: any[] = [];
    if (index > 0) buttons.push({ text: 'Move up', onPress: () => moveAccount(account.id, -1) });
    if (index < accounts.length - 1) buttons.push({ text: 'Move down', onPress: () => moveAccount(account.id, 1) });
    buttons.push({
      text: 'Delete',
      style: 'destructive',
      onPress: () =>
        Alert.alert('Delete account?', `"${account.name}" and its history will be removed from this device.`, [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Delete', style: 'destructive', onPress: () => deleteAccount(account.id) },
        ]),
    });
    buttons.push({ text: 'Cancel', style: 'cancel' });
    Alert.alert(account.name, account.email, buttons);
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <ScreenHeader
          large
          title="Accounts"
          subtitle="Manage all your AI accounts"
          right={
            <TouchableOpacity onPress={refreshAll} hitSlop={10} disabled={isSyncing}>
              <RefreshCw size={20} color={isSyncing ? Colors.textSubtle : Colors.text} />
            </TouchableOpacity>
          }
        />

        <PrimaryButton
          label="Add account"
          icon={<Plus size={18} color="#fff" />}
          onPress={() => router.push('/create')}
          style={{ marginBottom: 16 }}
        />

        {accounts.map((account, index) => {
          const snap = snapshots[account.id];
          const status = accountStatus(account, snap);
          return (
            <Card
              key={account.id}
              style={styles.row}
              onPress={() => router.push({ pathname: '/account/[id]', params: { id: account.id } })}
            >
              <TouchableOpacity onLongPress={() => openActions(account, index)} delayLongPress={300}>
                <ProviderLogo type={account.providerType} size={46} />
              </TouchableOpacity>
              <View style={{ flex: 1 }}>
                <Text style={styles.name} numberOfLines={1}>
                  {account.name}
                </Text>
                <Text style={styles.email} numberOfLines={1}>
                  {account.email || `updated ${formatRelative(account.lastSyncAt)}`}
                </Text>
              </View>
              <StatusDot status={status} size="sm" />
              <TouchableOpacity onPress={() => openActions(account, index)} hitSlop={8}>
                <ChevronRight size={18} color={Colors.textSubtle} />
              </TouchableOpacity>
            </Card>
          );
        })}

        {accounts.length === 0 && (
          <EmptyState title="No accounts" text='Tap "Add account" to connect your first service.' />
        )}
        {accounts.length > 1 && (
          <Text style={styles.hint}>Press and hold the logo or tap the arrow to reorder or delete.</Text>
        )}
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
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 10,
    paddingVertical: 16,
  },
  name: {
    fontSize: 15,
    fontWeight: '700',
    color: Colors.text,
  },
  email: {
    fontSize: 12,
    color: Colors.textMuted,
    marginTop: 3,
  },
  hint: {
    fontSize: 11.5,
    color: Colors.textSubtle,
    textAlign: 'center',
    marginTop: 6,
  },
});
