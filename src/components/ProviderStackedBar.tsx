import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Colors, getAccessibleSegmentTextColor, getProviderAccountShades, LAB_BRAND_PALETTES, PROVIDER_NAMES, Radius } from '../constants/theme';
import { AccountEntity, ProviderType, UsageSnapshot } from '../models/types';
import { formatTimeRemaining } from '../utils/formatters';

export interface ProviderStackedBarProps {
  provider: ProviderType;
  accounts: AccountEntity[];
  snapshots: Record<string, UsageSnapshot>;
  windowMode: 'weekly' | 'rolling5h';
  onSelectAccount?: (accountId: string) => void;
  onNavigateFleet?: (provider: ProviderType) => void;
}

export function getAccountQuotaMetrics(
  account: AccountEntity,
  snapshot: UsageSnapshot | undefined,
  windowMode: 'weekly' | 'rolling5h'
): { remainingPct: number; resetsAt: string | null; isExhausted: boolean } {
  const buckets = snapshot?.buckets || [];
  if (windowMode === 'rolling5h') {
    const session = buckets.find((b) => b.windowType === 'session_5h') || buckets[0];
    const rem = session?.remainingPercent ?? 100;
    return {
      remainingPct: Math.max(0, Math.min(100, rem)),
      resetsAt: session?.resetsAt || null,
      isExhausted: session?.isExhausted || rem <= 10,
    };
  }
  // Weekly Quota (default)
  const weekly = buckets.find((b) => b.windowType === 'weekly_7d') || buckets[0];
  const rem = weekly?.remainingPercent ?? 100;
  return {
    remainingPct: Math.max(0, Math.min(100, rem)),
    resetsAt: weekly?.resetsAt || null,
    isExhausted: weekly?.isExhausted || rem <= 10,
  };
}

export const ProviderStackedBar: React.FC<ProviderStackedBarProps> = ({
  provider,
  accounts,
  snapshots,
  windowMode,
  onSelectAccount,
  onNavigateFleet,
}) => {
  if (!accounts.length) return null;

  const shades = getProviderAccountShades(provider, accounts.length);
  const providerTitle = PROVIDER_NAMES[provider] || provider;
  const brandPalette = LAB_BRAND_PALETTES[provider] || { primary: Colors.custom.primary };

  // Calculate quota remaining & health triage per account
  let healthyCount = 0;
  let lowCount = 0;
  let exhaustedCount = 0;

  const segmentData = accounts.map((account, index) => {
    const snap = snapshots[account.id];
    const metrics = getAccountQuotaMetrics(account, snap, windowMode);
    const shade = shades[index] || brandPalette.primary;
    const textColor = getAccessibleSegmentTextColor(shade);

    if (metrics.isExhausted || metrics.remainingPct < 10) {
      exhaustedCount++;
    } else if (metrics.remainingPct <= 50) {
      lowCount++;
    } else {
      healthyCount++;
    }

    return {
      account,
      metrics,
      shade,
      textColor,
    };
  });

  // Calculate weighted or normalized bar widths
  const totalRemaining = segmentData.reduce((acc, curr) => acc + curr.metrics.remainingPct, 0);
  const averageRemaining = Math.round(totalRemaining / accounts.length);

  return (
    <View style={styles.container}>
      {/* Provider Header with status indicator dots */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.providerInfo}
          activeOpacity={0.7}
          onPress={() => onNavigateFleet?.(provider)}
          accessibilityRole="button"
          accessibilityLabel={`View all ${providerTitle} fleet accounts`}
        >
          <View style={[styles.brandPip, { backgroundColor: brandPalette.primary }]} />
          <Text style={styles.providerName}>{providerTitle}</Text>
          <Text style={styles.accountCount}>({accounts.length})</Text>
        </TouchableOpacity>

        {/* Accessible status indicator dots & label */}
        <View style={styles.statusRow}>
          <View style={styles.dotGroup} accessibilityRole="text" accessibilityLabel={`${healthyCount} healthy, ${lowCount} low, ${exhaustedCount} exhausted`}>
            {segmentData.map(({ account, metrics }, idx) => {
              const isExhausted = metrics.isExhausted || metrics.remainingPct < 10;
              const isLow = metrics.remainingPct >= 10 && metrics.remainingPct <= 50;
              const dotColor = isExhausted ? Colors.exhausted : isLow ? Colors.warning : Colors.normal;
              return (
                <View
                  key={account.id}
                  style={[
                    styles.statusDot,
                    { backgroundColor: dotColor },
                    isExhausted && styles.pulsingDotBorder,
                  ]}
                />
              );
            })}
          </View>
          <Text style={styles.healthSummaryText}>
            {exhaustedCount > 0
              ? `${exhaustedCount} exhausted`
              : lowCount > 0
              ? `${lowCount} low`
              : 'All Healthy'}
          </Text>
        </View>
      </View>

      {/* Multi-account Stacked Quota Bar */}
      <View style={styles.barTrack}>
        {segmentData.map(({ account, metrics, shade, textColor }, index) => {
          // Proportion based on account remaining capacity
          const widthPct = totalRemaining > 0 ? (metrics.remainingPct / totalRemaining) * 100 : 100 / accounts.length;
          // Hit-slop ensures small slices remain pressable
          return (
            <TouchableOpacity
              key={account.id}
              style={[
                styles.segment,
                {
                  flex: Math.max(0.1, metrics.remainingPct),
                  backgroundColor: shade,
                },
              ]}
              activeOpacity={0.85}
              onPress={() => onSelectAccount?.(account.id)}
              accessibilityRole="button"
              accessibilityLabel={`#${index + 1} ${account.name} (${Math.round(metrics.remainingPct)}%)`}
            >
              {accounts.length <= 4 && (
                <Text style={[styles.segmentLabel, { color: textColor }]} numberOfLines={1}>
                  #{index + 1} ({Math.round(metrics.remainingPct)}%)
                </Text>
              )}
            </TouchableOpacity>
          );
        })}
      </View>

      {/* Footer Capacity Summary */}
      <View style={styles.footer}>
        <Text style={styles.footerCapText}>
          Fleet capacity: <Text style={styles.bold}>{averageRemaining}%</Text> left ({windowMode === 'weekly' ? 'Weekly' : '5-Hour'})
        </Text>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    backgroundColor: Colors.card,
    borderRadius: Radius.lg,
    padding: 16,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  providerInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  brandPip: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  providerName: {
    fontSize: 16,
    fontWeight: '700',
    color: Colors.text,
  },
  accountCount: {
    fontSize: 13,
    color: Colors.textMuted,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  dotGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  pulsingDotBorder: {
    borderWidth: 1,
    borderColor: '#ffffff',
  },
  healthSummaryText: {
    fontSize: 12,
    fontWeight: '600',
    color: Colors.textMuted,
  },
  barTrack: {
    height: 28,
    backgroundColor: Colors.track,
    borderRadius: 8,
    flexDirection: 'row',
    overflow: 'hidden',
  },
  segment: {
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 4,
    minWidth: 16,
    borderRightWidth: 1,
    borderRightColor: 'rgba(255, 255, 255, 0.25)',
  },
  segmentLabel: {
    fontSize: 11,
    fontWeight: '700',
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 8,
  },
  footerCapText: {
    fontSize: 12,
    color: Colors.textMuted,
  },
  bold: {
    fontWeight: '700',
    color: Colors.text,
  },
});
