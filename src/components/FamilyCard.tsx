import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { ArrowRight, Clock, Sparkles } from 'lucide-react-native';
import { Colors, PROVIDER_NAMES, Radius, severityColor } from '../constants/theme';
import { ProviderType } from '../models/types';
import { arcPath, familySlots, FamilySummary, Weighting } from '../services/capacity';
import { formatTimeRemaining } from '../utils/formatters';

export interface FamilyCardProps {
  summary: FamilySummary;
  colors: Record<string, string>;
  onSelect?: (family: ProviderType) => void;
  active?: boolean;
  weighting?: Weighting;
  variant?: 'compact' | 'detailed';
}

function formatUnits(units: number): string {
  if (units < 10) {
    const fixed = units.toFixed(1);
    return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed;
  }
  return String(Math.round(units));
}

export const FamilyDonut: React.FC<{
  summary: FamilySummary;
  size?: number;
  colors: Record<string, string>;
  weighting?: Weighting;
}> = ({ summary, size = 112, colors, weighting = 'equal' }) => {
  const { members, poolUnits, poolMax, poolPct } = summary;
  const isSingle = members.length === 1;
  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.42;
  const strokeWidth = Math.max(8, Math.round(size * 0.12));

  // Compute geometry slots using pure helper
  const slots = familySlots(
    members.map((m) => ({
      id: m.id,
      weight: m.weight ?? 1,
      effectiveRemaining: m.effectiveRemaining,
    })),
    3
  );

  return (
    <View style={{ width: size, height: size, justifyContent: 'center', alignItems: 'center' }}>
      <Svg width={size} height={size}>
        {slots.map((s, idx) => {
          const m = members[idx];
          if (!m) return null;
          const memberColor = colors[m.id] || Colors.track;
          const slotTrackD = arcPath(cx, cy, r, s.start, s.end);
          const fillD = s.fillEnd > s.start ? arcPath(cx, cy, r, s.start, s.fillEnd) : null;
          const effColor = severityColor(m.effectiveRemaining ?? null, m.providerType);

          return (
            <React.Fragment key={m.id || idx}>
              {/* Background slot track tinted with account chart color at ~18% opacity (hex 2e) */}
              <Path
                d={slotTrackD}
                stroke={`${memberColor}2e`}
                strokeWidth={strokeWidth}
                fill="none"
                strokeLinecap="butt"
                strokeDasharray={weighting === 'plan' ? '3 3' : undefined}
              />
              {/* Value arc */}
              {fillD && (
                <Path
                  d={fillD}
                  stroke={effColor}
                  strokeWidth={strokeWidth}
                  fill="none"
                  strokeLinecap="butt"
                />
              )}
            </React.Fragment>
          );
        })}
      </Svg>
      <View style={styles.donutCenter}>
        {isSingle ? (
          <>
            <Text style={[styles.donutValue, { fontSize: Math.round(size * 0.22) }]}>
              {poolPct === null ? '—' : `${Math.round(poolPct)}%`}
            </Text>
            <Text style={[styles.donutSub, { fontSize: Math.max(9, Math.round(size * 0.09)) }]}>
              left
            </Text>
          </>
        ) : (
          <>
            <Text style={[styles.donutValue, { fontSize: Math.round(size * 0.22) }]}>
              {formatUnits(poolUnits)}
            </Text>
            <Text
              style={[styles.donutSub, { fontSize: Math.max(9, Math.round(size * 0.09)) }]}
              numberOfLines={2}
            >
              {weighting === 'plan'
                ? `of ${poolMax} Pro-eq.`
                : `of ${poolMax} ${poolMax === 1 ? 'account' : 'accounts'}`}
            </Text>
          </>
        )}
      </View>
    </View>
  );
};

export const FamilyCard: React.FC<FamilyCardProps> = ({
  summary,
  colors,
  onSelect,
  active = false,
  weighting = 'equal',
  variant = 'compact',
}) => {
  const { family, members, earliestReset, useNext } = summary;
  const isDetailed = variant === 'detailed';
  const providerLabel = PROVIDER_NAMES[family] || family;

  // Find member corresponding to earliestReset
  const earliestAccount = earliestReset
    ? members.find((m) => m.id === earliestReset.accountId)
    : null;

  return (
    <Pressable
      onPress={() => onSelect?.(family)}
      style={({ pressed }) => [
        styles.card,
        isDetailed ? styles.cardDetailed : styles.cardCompact,
        active && styles.cardActive,
        pressed && onSelect && styles.cardPressed,
      ]}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={`${providerLabel} family quota`}
    >
      <View style={isDetailed ? styles.topRowDetailed : styles.topRowCompact}>
        <FamilyDonut
          summary={summary}
          size={isDetailed ? 130 : 100}
          colors={colors}
          weighting={weighting}
        />
        <View style={styles.headerInfo}>
          <Text style={styles.familyTitle} numberOfLines={1}>
            {providerLabel}
          </Text>
          <Text style={styles.memberCount}>
            {members.length} {members.length === 1 ? 'account' : 'accounts'}
          </Text>
          {isDetailed && summary.poolPct !== null && (
            <Text style={styles.poolPctText}>
              {Math.round(summary.poolPct)}% capacity left
            </Text>
          )}
        </View>
      </View>

      {/* Compact footer rows: recommended useNext or earliest reset */}
      {!isDetailed && (
        <View style={styles.compactFooter}>
          {useNext && (
            <View style={styles.metaRow}>
              <Sparkles size={12} color={Colors.ring} />
              <Text style={styles.metaText} numberOfLines={1}>
                Use next:{' '}
                <Text style={styles.metaBold}>
                  {useNext.name} · {Math.round(useNext.effectiveRemaining ?? 0)}%
                </Text>
              </Text>
            </View>
          )}
          {earliestReset && (
            <View style={styles.metaRow}>
              <Clock size={12} color={Colors.textMuted} />
              <Text style={styles.metaText} numberOfLines={1}>
                Next reset {formatTimeRemaining(earliestReset.at)}
                {earliestAccount ? ` · ${earliestAccount.name}` : ''}
              </Text>
            </View>
          )}
        </View>
      )}

      {/* Detailed view: member list with identity color dot, name, effective %, and reset */}
      {isDetailed && (
        <View style={styles.detailedLegend}>
          {members.map((m) => {
            const memberColor = colors[m.id] || Colors.track;
            const eff = m.effectiveRemaining;
            const effColor = severityColor(eff ?? null, m.providerType);
            return (
              <View key={m.id} style={styles.legendRow}>
                <View style={[styles.legendDot, { backgroundColor: memberColor }]} />
                <Text style={styles.legendName} numberOfLines={1}>
                  {m.name}
                </Text>
                {m.bindingResetsAt && (
                  <Text style={styles.legendReset} numberOfLines={1}>
                    {formatTimeRemaining(m.bindingResetsAt)}
                  </Text>
                )}
                <Text style={[styles.legendValue, { color: effColor }]}>
                  {eff === null || eff === undefined ? '—' : `${Math.round(eff)}%`}
                </Text>
              </View>
            );
          })}
        </View>
      )}
    </Pressable>
  );
};

const styles = StyleSheet.create({
  card: {
    backgroundColor: Colors.card,
    borderRadius: Radius.xl,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 14,
  },
  cardCompact: {
    minWidth: 220,
    maxWidth: 280,
  },
  cardDetailed: {
    width: '100%',
  },
  cardActive: {
    borderColor: Colors.ink,
    borderWidth: 1.5,
  },
  cardPressed: {
    transform: [{ scale: 0.985 }],
    backgroundColor: '#f7f6f2',
  },
  topRowCompact: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  topRowDetailed: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    marginBottom: 14,
  },
  headerInfo: {
    flex: 1,
    justifyContent: 'center',
  },
  familyTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: Colors.text,
    letterSpacing: -0.3,
  },
  memberCount: {
    fontSize: 12,
    color: Colors.textMuted,
    marginTop: 2,
  },
  poolPctText: {
    fontSize: 13,
    fontWeight: '600',
    color: Colors.text,
    marginTop: 4,
  },
  donutCenter: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  donutValue: {
    fontWeight: '800',
    color: Colors.text,
    letterSpacing: -0.5,
  },
  donutSub: {
    fontWeight: '500',
    color: Colors.textMuted,
    textAlign: 'center',
    marginTop: -1,
  },
  compactFooter: {
    marginTop: 10,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: Colors.borderSubtle,
    gap: 4,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  metaText: {
    fontSize: 11.5,
    color: Colors.textMuted,
    flex: 1,
  },
  metaBold: {
    fontWeight: '700',
    color: Colors.text,
  },
  detailedLegend: {
    borderTopWidth: 1,
    borderTopColor: Colors.borderSubtle,
    paddingTop: 10,
    gap: 8,
  },
  legendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  legendName: {
    flex: 1,
    fontSize: 12.5,
    color: Colors.text,
  },
  legendReset: {
    fontSize: 11,
    color: Colors.textMuted,
  },
  legendValue: {
    fontSize: 12.5,
    fontWeight: '700',
    minWidth: 36,
    textAlign: 'right',
  },
});
