import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Clock } from 'lucide-react-native';
import { Colors, SeverityTokens, severityOf } from '../constants/theme';
import { AccountEntity, UsageSnapshot } from '../models/types';
import { RingWindow, resolveRingWindows } from '../services/capacity';
import { getHistoryFromDb } from '../services/db';
import { formatClock, formatTimeRemaining } from '../utils/formatters';
import { MiniBars } from './Charts';
import { DualRing } from './CircularProgress';
import { ProviderLogo } from './ProviderLogo';
import { Card, StatusDot, accountStatus } from './ui';

export interface AccountCardProps {
  account: AccountEntity;
  snapshot?: UsageSnapshot;
  badge?: React.ReactNode;
}

export const AccountCard: React.FC<AccountCardProps> = ({ account, snapshot, badge }) => {
  const router = useRouter();
  const [bars, setBars] = useState<Array<number | null>>([]);

  useEffect(() => {
    let alive = true;
    getHistoryFromDb(account.id, 10)
      .then((h) => alive && setBars(h.map((p) => p.primaryUtilization)))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [account.id, snapshot?.fetchedAt]);

  const data = resolveRingWindows(snapshot?.buckets);
  const status = accountStatus(account, snapshot);
  const subtitle = [snapshot?.planName || account.plan, account.email].filter(Boolean).join(' · ');

  // Countdowns: render one entry per ring window whose remaining < 100 && resetsAt
  // Binding countdown is highlighted, secondary is muted
  const countdownWindows = [data.inner, data.outer].filter(
    (w): w is RingWindow => Boolean(w && w.remaining < 100 && w.bucket.resetsAt)
  );

  const hasFooter = countdownWindows.length > 0 || Boolean(snapshot?.isStale) || bars.length > 0;

  return (
    <Card
      style={styles.card}
      onPress={() => router.push({ pathname: '/account/[id]', params: { id: account.id } })}
    >
      <View style={styles.body}>
        <View style={styles.left}>
          <ProviderLogo type={account.providerType} size={44} />
          <View style={styles.meta}>
            <View style={styles.nameRow}>
              <Text style={styles.name} numberOfLines={1}>
                {account.name}
              </Text>
              {badge && <View style={styles.badgeContainer}>{badge}</View>}
            </View>

            <Text style={styles.plan} numberOfLines={1}>
              {subtitle || '—'}
            </Text>

            <View style={styles.statusPillsRow}>
              <StatusDot status={status} />
              {data.extras.slice(0, 2).map((extra) => {
                const sev = severityOf(extra.remaining);
                const tok = SeverityTokens[sev];
                return (
                  <View key={extra.short} style={[styles.pill, { backgroundColor: tok.soft }]}>
                    <Text style={[styles.pillText, { color: tok.ink }]}>
                      {extra.short} {Math.round(extra.remaining)}%
                    </Text>
                  </View>
                );
              })}
              {data.extras.length > 2 && (
                <View style={[styles.pill, { backgroundColor: Colors.cardHighlight }]}>
                  <Text style={[styles.pillText, { color: Colors.textMuted }]}>
                    +{data.extras.length - 2}
                  </Text>
                </View>
              )}
            </View>
          </View>
        </View>

        <DualRing
          data={data}
          size={80}
          providerType={account.providerType}
          dimmed={snapshot?.isStale}
        />
      </View>

      {hasFooter && (
        <View style={styles.footer}>
          <View style={styles.footerLeft}>
            {countdownWindows.length > 0 ? (
              <View style={styles.countdownRow}>
                <Clock size={12} color={Colors.textMuted} strokeWidth={2} />
                <View style={styles.countdownList}>
                  {countdownWindows.map((w, idx) => {
                    const isBinding = data.binding?.short === w.short;
                    return (
                      <React.Fragment key={w.short}>
                        {idx > 0 && <Text style={styles.countdownSeparator}>·</Text>}
                        <Text
                          style={[
                            styles.countdownText,
                            isBinding ? styles.countdownBinding : styles.countdownSecondary,
                          ]}
                        >
                          {w.short} {formatTimeRemaining(w.bucket.resetsAt)}
                        </Text>
                      </React.Fragment>
                    );
                  })}
                </View>
              </View>
            ) : (
              <View />
            )}
          </View>

          <View style={styles.footerRight}>
            {snapshot?.isStale ? (
              <Text style={styles.stale}>data from {formatClock(snapshot.fetchedAt)}</Text>
            ) : (
              <MiniBars values={bars} />
            )}
          </View>
        </View>
      )}
    </Card>
  );
};

const styles = StyleSheet.create({
  card: {
    paddingVertical: 14,
    paddingHorizontal: 14,
    marginBottom: 12,
  },
  body: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  left: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginRight: 10,
    minWidth: 0,
  },
  meta: {
    flex: 1,
    gap: 3,
    minWidth: 0,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  name: {
    fontSize: 15.5,
    fontWeight: '700',
    color: Colors.text,
    letterSpacing: -0.3,
    flexShrink: 1,
  },
  badgeContainer: {
    flexShrink: 0,
  },
  plan: {
    fontSize: 12,
    color: Colors.textMuted,
  },
  statusPillsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
    marginTop: 2,
  },
  pill: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 999,
  },
  pillText: {
    fontSize: 10.5,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  footer: {
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: Colors.borderSubtle,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
  },
  footerLeft: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  countdownRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    flexWrap: 'wrap',
  },
  countdownList: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    flexWrap: 'wrap',
  },
  countdownText: {
    fontSize: 12,
    fontVariant: ['tabular-nums'],
  },
  countdownBinding: {
    fontWeight: '700',
    color: Colors.text,
  },
  countdownSecondary: {
    fontWeight: '500',
    color: Colors.textMuted,
  },
  countdownSeparator: {
    fontSize: 12,
    color: Colors.textMuted,
    marginHorizontal: 1,
  },
  footerRight: {
    alignItems: 'flex-end',
  },
  stale: {
    fontSize: 10.5,
    color: Colors.warning,
    textAlign: 'right',
  },
});
