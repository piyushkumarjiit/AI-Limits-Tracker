import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  AlertTriangle,
  CalendarClock,
  Clock,
  Gauge,
  LogIn,
  MoreHorizontal,
  Timer,
  Trash2,
  Wallet,
} from 'lucide-react-native';
import { AccountLoginSheet } from '../../components/AccountLoginSheet';
import { BarChart, LineChart } from '../../components/Charts';
import { CircularProgress } from '../../components/CircularProgress';
import { ProviderLogo } from '../../components/ProviderLogo';
import { accountStatus, Card, PrimaryButton, ScreenHeader, SectionTitle, Segmented, StatusPill } from '../../components/ui';
import { Colors, PROVIDER_NAMES, Radius } from '../../constants/theme';
import { NotificationSettings, QuotaBucket, UsageHistoryPoint } from '../../models/types';
import { getHistorySince, getNotificationSettings, updateNotificationSettings } from '../../services/db';
import { headlineBucket } from '../../services/notificationService';
import { useAppStore } from '../../store/useAppStore';
import { formatClock, formatRelative, formatTimeRemaining, useNow, WEEKDAYS_SHORT } from '../../utils/formatters';

type Tab = 'overview' | 'limits' | 'history' | 'settings';

function dailyMax(points: UsageHistoryPoint[], days: number, pick: (p: UsageHistoryPoint) => number | null) {
  const labels: string[] = [];
  const values: Array<number | null> = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const start = today.getTime() - i * 86400000;
    const end = start + 86400000;
    const d = new Date(start);
    labels.push(days <= 7 ? WEEKDAYS_SHORT[d.getDay()] : i % 5 === 0 ? String(d.getDate()) : '');
    let max: number | null = null;
    for (const p of points) {
      const t = new Date(p.fetchedAt).getTime();
      const v = pick(p);
      if (t >= start && t < end && v !== null) max = Math.max(max ?? 0, v);
    }
    values.push(max);
  }
  return { labels, values };
}

export default function AccountDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { accounts, snapshots, refreshSingle, deleteAccount, renameAccount, setAccountActive } = useAppStore();
  const account = accounts.find((a) => a.id === id);
  const snapshot = id ? snapshots[id] : undefined;

  const [tab, setTab] = useState<Tab>('overview');
  const [range, setRange] = useState<7 | 30>(7);
  const [history, setHistory] = useState<UsageHistoryPoint[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState(account?.name || '');
  const [notif, setNotif] = useState<NotificationSettings | null>(null);
  useNow(30000);

  useEffect(() => {
    if (!id) return;
    getHistorySince(new Date(Date.now() - 30 * 86400000).toISOString(), id)
      .then(setHistory)
      .catch(() => setHistory([]));
  }, [id, snapshot?.fetchedAt]);

  useEffect(() => {
    if (id) getNotificationSettings(id).then(setNotif).catch(() => {});
  }, [id]);

  useEffect(() => {
    if (account) setNameDraft(account.name);
  }, [account?.name]);

  const chart = useMemo(() => dailyMax(history, range, (p) => p.primaryUtilization), [history, range]);

  if (!account) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={{ padding: 18 }}>
          <ScreenHeader title="Account not found" />
        </View>
      </SafeAreaView>
    );
  }

  const status = accountStatus(account, snapshot);
  const main = headlineBucket(snapshot);
  const needsLogin = snapshot?.status === 'reauth_required' || snapshot?.status === 'not_configured';

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await refreshSingle(account.id);
    } finally {
      setRefreshing(false);
    }
  };

  const confirmDelete = () =>
    Alert.alert('Delete account?', `"${account.name}", its tokens, and history will be removed from this device.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          await deleteAccount(account.id);
          router.back();
        },
      },
    ]);

  const openMenu = () =>
    Alert.alert(account.name, undefined, [
      { text: 'Refresh now', onPress: onRefresh },
      { text: 'Reconnect', onPress: () => setLoginOpen(true) },
      { text: 'Delete', style: 'destructive', onPress: confirmDelete },
      { text: 'Cancel', style: 'cancel' },
    ]);

  const toggleNotif = async (key: keyof NotificationSettings) => {
    if (!notif) return;
    const next = { ...notif, [key]: !notif[key] };
    setNotif(next);
    await updateNotificationSettings(next);
  };

  const tiles = (snapshot?.buckets || []).slice(0, 3);

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.ring} />}
      >
        <ScreenHeader
          title=""
          right={
            <TouchableOpacity onPress={openMenu} hitSlop={12}>
              <MoreHorizontal size={22} color={Colors.text} />
            </TouchableOpacity>
          }
        />

        <View style={styles.identity}>
          <ProviderLogo type={account.providerType} size={54} />
          <View style={{ flex: 1 }}>
            <Text style={styles.title} numberOfLines={1}>
              {account.name}
            </Text>
            <Text style={styles.subtitle} numberOfLines={1}>
              {[snapshot?.planName || account.plan, account.email].filter(Boolean).join(' · ') ||
                PROVIDER_NAMES[account.providerType]}
            </Text>
          </View>
          <StatusPill status={status} />
        </View>

        {(needsLogin || snapshot?.status === 'error' || snapshot?.status === 'rate_limited') && (
          <View style={[styles.alert, needsLogin && { borderColor: Colors.exhausted }]}>
            <AlertTriangle size={16} color={needsLogin ? Colors.exhausted : Colors.warning} />
            <View style={{ flex: 1 }}>
              <Text style={styles.alertText}>{snapshot?.errorMessage || 'Refresh error'}</Text>
              {snapshot?.isStale && (
                <Text style={styles.alertSub}>Showing data from {formatClock(snapshot.fetchedAt)}</Text>
              )}
            </View>
            {needsLogin && (
              <TouchableOpacity style={styles.alertBtn} onPress={() => setLoginOpen(true)}>
                <Text style={styles.alertBtnText}>Sign in</Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        <Segmented
          value={tab}
          onChange={setTab}
          style={{ marginBottom: 18 }}
          options={[
            { key: 'overview', label: 'Overview' },
            { key: 'limits', label: 'Limits' },
            { key: 'history', label: 'History' },
            { key: 'settings', label: 'Settings' },
          ]}
        />

        {tab === 'overview' && (
          <>
            <View style={styles.ringWrap}>
              <CircularProgress
                size={210}
                strokeWidth={16}
                remainingPercent={main?.remainingPercent ?? null}
                providerType={account.providerType}
                dimmed={snapshot?.isStale}
              />
              {main && <Text style={styles.ringCaption}>{main.label}</Text>}
              <Text style={styles.resetLabel}>Resets in</Text>
              <View style={styles.resetRow}>
                <Clock size={18} color={Colors.text} strokeWidth={2.4} />
                <Text style={styles.resetValue}>{formatTimeRemaining(main?.resetsAt)}</Text>
              </View>
            </View>

            {tiles.length > 0 && (
              <View style={styles.tiles}>
                {tiles.map((b) => (
                  <BucketTile key={b.id} bucket={b} />
                ))}
              </View>
            )}

            <SectionTitle
              right={
                <Segmented
                  value={String(range) as '7' | '30'}
                  onChange={(v) => setRange(Number(v) as 7 | 30)}
                  style={{ width: 130, padding: 3 }}
                  options={[
                    { key: '7', label: '7 days' },
                    { key: '30', label: '30 days' },
                  ]}
                />
              }
            >
              Usage over {range} days
            </SectionTitle>
            <Card>
              {chart.values.some((v) => v !== null) ? (
                <BarChart
                  labels={chart.labels}
                  series={[{ color: '#5f5d58', values: chart.values }]}
                  max={100}
                  ticks={[0, 50, 100]}
                  height={140}
                />
              ) : (
                <Text style={styles.emptyChart}>
                  The chart fills in automatically: each refresh saves the day's peak load measurement.
                </Text>
              )}
            </Card>
            <Text style={styles.updated}>Updated {formatRelative(account.lastSyncAt)}</Text>
          </>
        )}

        {tab === 'limits' && (
          <>
            {(snapshot?.buckets || []).map((b) => (
              <LimitRow key={b.id} bucket={b} />
            ))}
            {snapshot?.credits && (
              <Card style={styles.limitCard}>
                <View style={styles.limitHead}>
                  <Wallet size={16} color={Colors.textMuted} />
                  <Text style={styles.limitTitle}>Credit balance</Text>
                  <Text style={styles.limitValue}>
                    {snapshot.credits.balance} {snapshot.credits.currency}
                  </Text>
                </View>
              </Card>
            )}
            {!snapshot?.buckets?.length && (
              <Text style={styles.emptyChart}>
                {needsLogin ? 'Sign in to the account to see limits.' : 'The service did not return any limits.'}
              </Text>
            )}
          </>
        )}

        {tab === 'history' && (
          <>
            <Card style={{ marginBottom: 14 }}>
              <Text style={styles.cardLabel}>Session window, usage %</Text>
              {history.length ? (
                <LineChart
                  labels={[]}
                  values={history.slice(-40).map((p) => p.primaryUtilization)}
                  color={Colors[account.providerType].chart}
                  height={150}
                />
              ) : (
                <Text style={styles.emptyChart}>History is empty for now.</Text>
              )}
            </Card>
            {[...history]
              .reverse()
              .slice(0, 30)
              .map((p) => (
                <View key={p.id} style={styles.historyRow}>
                  <Text style={styles.historyTime}>
                    {new Date(p.fetchedAt).toLocaleDateString('en-US', { day: 'numeric', month: 'short' })},{' '}
                    {new Date(p.fetchedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
                  </Text>
                  <Text style={styles.historyVal}>{p.primaryUtilization ?? '—'}%</Text>
                  <Text style={[styles.historyVal, { color: Colors.textMuted }]}>
                    {p.secondaryUtilization != null ? `${p.secondaryUtilization}%` : '—'}
                  </Text>
                </View>
              ))}
            {history.length > 0 && (
              <Text style={styles.updated}>Columns: session · weekly</Text>
            )}
          </>
        )}

        {tab === 'settings' && (
          <>
            <Card style={{ marginBottom: 14 }}>
              <Text style={styles.cardLabel}>Name</Text>
              <View style={styles.nameRow}>
                <TextInput
                  style={styles.nameInput}
                  value={nameDraft}
                  onChangeText={setNameDraft}
                  placeholder="Account name"
                  placeholderTextColor={Colors.textSubtle}
                />
                {nameDraft.trim() && nameDraft !== account.name ? (
                  <TouchableOpacity style={styles.saveBtn} onPress={() => renameAccount(account.id, nameDraft)}>
                    <Text style={styles.saveText}>Save</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
              {account.email ? <Text style={styles.metaLine}>Account: {account.email}</Text> : null}
              <View style={styles.switchRow}>
                <Text style={styles.switchLabel}>Track</Text>
                <Switch
                  value={account.isActive}
                  onValueChange={(v) => setAccountActive(account.id, v)}
                  trackColor={{ true: Colors.ring, false: Colors.track }}
                />
              </View>
            </Card>

            {notif && (
              <Card style={{ marginBottom: 14 }}>
                <Text style={styles.cardLabel}>Notifications</Text>
                <SwitchRow label="Less than 20% remaining" value={notif.notifyAt20} onChange={() => toggleNotif('notifyAt20')} />
                <SwitchRow label="Less than 10% remaining" value={notif.notifyAt10} onChange={() => toggleNotif('notifyAt10')} />
                <SwitchRow label="Limit exhausted" value={notif.notifyAt0} onChange={() => toggleNotif('notifyAt0')} />
                <SwitchRow label="Limit restored" value={notif.notifyOnRestore} onChange={() => toggleNotif('notifyOnRestore')} />
                <SwitchRow label="Sign-in required" value={notif.notifyOnReauth} onChange={() => toggleNotif('notifyOnReauth')} />
              </Card>
            )}

            <PrimaryButton
              label="Reconnect account"
              variant="light"
              icon={<LogIn size={18} color={Colors.text} />}
              onPress={() => setLoginOpen(true)}
              style={{ marginBottom: 10 }}
            />
            <PrimaryButton
              label="Delete account"
              variant="danger"
              icon={<Trash2 size={18} color={Colors.exhausted} />}
              onPress={confirmDelete}
            />
          </>
        )}

        {refreshing && <ActivityIndicator style={{ marginTop: 12 }} color={Colors.textMuted} />}
      </ScrollView>

      {loginOpen && (
        <AccountLoginSheet
          visible
          providerType={account.providerType}
          account={account}
          onClose={() => setLoginOpen(false)}
        />
      )}
    </SafeAreaView>
  );
}

function bucketIcon(b: QuotaBucket) {
  if (b.windowType === 'session_5h') return <Timer size={14} color={Colors.textMuted} />;
  if (b.windowType === 'weekly_7d') return <CalendarClock size={14} color={Colors.textMuted} />;
  if (b.windowType === 'monthly_30d') return <Wallet size={14} color={Colors.textMuted} />;
  return <Gauge size={14} color={Colors.textMuted} />;
}

const BucketTile: React.FC<{ bucket: QuotaBucket }> = ({ bucket }) => (
  <View style={styles.tile}>
    <View style={styles.tileHead}>
      {bucketIcon(bucket)}
      <Text style={styles.tileLabel} numberOfLines={1}>
        {bucket.label}
      </Text>
    </View>
    <Text style={styles.tileValue}>
      {bucket.details?.used
        ? `$${bucket.details.used}`
        : bucket.remainingPercent === null
        ? '—'
        : `${Math.round(bucket.remainingPercent)}%`}
      <Text style={styles.tileSuffix}>{bucket.details?.limit ? ` / $${bucket.details.limit}` : ' left'}</Text>
    </Text>
  </View>
);

const LimitRow: React.FC<{ bucket: QuotaBucket }> = ({ bucket }) => {
  const used = bucket.utilizationPercent;
  const color =
    used === null ? Colors.unavailable : used >= 90 ? Colors.exhausted : used >= 70 ? Colors.critical : Colors.ring;
  return (
    <Card style={styles.limitCard}>
      <View style={styles.limitHead}>
        {bucketIcon(bucket)}
        <Text style={styles.limitTitle}>{bucket.label}</Text>
        <Text style={styles.limitValue}>{used === null ? '—' : `${Math.round(used)}% used`}</Text>
      </View>
      <View style={styles.limitTrack}>
        <View style={[styles.limitFill, { width: `${Math.min(100, used ?? 0)}%`, backgroundColor: color }]} />
      </View>
      <Text style={styles.limitMeta}>
        {bucket.details?.used
          ? `Spent $${bucket.details.used} of $${bucket.details.limit}`
          : bucket.resetsAt
          ? `Resets in ${formatTimeRemaining(bucket.resetsAt)} · ${new Date(bucket.resetsAt).toLocaleString('en-US', {
              weekday: 'short',
              hour: '2-digit',
              minute: '2-digit',
            })}`
          : 'Reset time not reported'}
      </Text>
    </Card>
  );
};

const SwitchRow: React.FC<{ label: string; value: boolean; onChange: () => void }> = ({ label, value, onChange }) => (
  <View style={styles.switchRow}>
    <Text style={styles.switchLabel}>{label}</Text>
    <Switch value={value} onValueChange={onChange} trackColor={{ true: Colors.ring, false: Colors.track }} />
  </View>
);

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  content: {
    paddingHorizontal: 18,
    paddingBottom: 40,
  },
  identity: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    marginBottom: 18,
  },
  title: {
    fontSize: 22,
    fontWeight: '800',
    color: Colors.text,
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: 13.5,
    color: Colors.textMuted,
    marginTop: 2,
  },
  alert: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 12,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.warning,
    backgroundColor: Colors.card,
    marginBottom: 14,
  },
  alertText: {
    fontSize: 12.5,
    color: Colors.text,
    lineHeight: 17,
  },
  alertSub: {
    fontSize: 11,
    color: Colors.textMuted,
    marginTop: 2,
  },
  alertBtn: {
    backgroundColor: Colors.ink,
    borderRadius: Radius.full,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  alertBtnText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 12.5,
  },
  ringWrap: {
    alignItems: 'center',
    marginVertical: 6,
  },
  ringCaption: {
    fontSize: 12,
    color: Colors.textMuted,
    marginTop: 10,
  },
  resetLabel: {
    fontSize: 13,
    color: Colors.textMuted,
    marginTop: 10,
  },
  resetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 2,
  },
  resetValue: {
    fontSize: 22,
    fontWeight: '800',
    color: Colors.text,
    letterSpacing: -0.5,
  },
  tiles: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 20,
  },
  tile: {
    flex: 1,
    backgroundColor: Colors.cardHighlight,
    borderRadius: Radius.md,
    padding: 12,
  },
  tileHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginBottom: 6,
  },
  tileLabel: {
    flex: 1,
    fontSize: 11,
    color: Colors.textMuted,
  },
  tileValue: {
    fontSize: 17,
    fontWeight: '700',
    color: Colors.text,
  },
  tileSuffix: {
    fontSize: 12,
    fontWeight: '500',
    color: Colors.textMuted,
  },
  emptyChart: {
    fontSize: 12.5,
    color: Colors.textMuted,
    textAlign: 'center',
    lineHeight: 18,
    paddingVertical: 24,
    paddingHorizontal: 10,
  },
  updated: {
    fontSize: 11.5,
    color: Colors.textSubtle,
    textAlign: 'center',
    marginTop: 14,
  },
  limitCard: {
    marginBottom: 10,
  },
  limitHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  limitTitle: {
    flex: 1,
    fontSize: 14.5,
    fontWeight: '700',
    color: Colors.text,
  },
  limitValue: {
    fontSize: 13,
    fontWeight: '600',
    color: Colors.textMuted,
  },
  limitTrack: {
    height: 8,
    borderRadius: 4,
    backgroundColor: Colors.track,
    marginTop: 12,
    overflow: 'hidden',
  },
  limitFill: {
    height: '100%',
    borderRadius: 4,
  },
  limitMeta: {
    fontSize: 12,
    color: Colors.textMuted,
    marginTop: 10,
  },
  cardLabel: {
    fontSize: 12.5,
    fontWeight: '600',
    color: Colors.textMuted,
    marginBottom: 10,
  },
  historyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 11,
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderSubtle,
  },
  historyTime: {
    flex: 1,
    fontSize: 13,
    color: Colors.text,
  },
  historyVal: {
    width: 64,
    textAlign: 'right',
    fontSize: 13,
    fontWeight: '600',
    color: Colors.text,
  },
  nameRow: {
    flexDirection: 'row',
    gap: 8,
  },
  nameInput: {
    flex: 1,
    backgroundColor: Colors.cardElevated,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.sm,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: Colors.text,
  },
  saveBtn: {
    backgroundColor: Colors.ink,
    borderRadius: Radius.sm,
    paddingHorizontal: 14,
    justifyContent: 'center',
  },
  saveText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 13,
  },
  metaLine: {
    fontSize: 12,
    color: Colors.textMuted,
    marginTop: 10,
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 6,
    marginTop: 4,
  },
  switchLabel: {
    fontSize: 14,
    color: Colors.text,
  },
});
