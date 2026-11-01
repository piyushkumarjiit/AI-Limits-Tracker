import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { Colors, remainingColor, SeverityTokens, severityColor } from '../constants/theme';
import { ProviderType, QuotaBucket } from '../models/types';
import { DualRingData, resolveRingWindows, ringA11yLabel } from '../services/capacity';

export interface CircularProgressProps {
  size?: number;
  strokeWidth?: number;
  /** 0-100, null when unknown */
  remainingPercent: number | null;
  providerType?: ProviderType;
  colorOverride?: string;
  sublabel?: string;
  dimmed?: boolean;
}

export const CircularProgress: React.FC<CircularProgressProps> = ({
  size = 76,
  strokeWidth = 7,
  remainingPercent,
  providerType,
  colorOverride,
  sublabel = 'remaining',
  dimmed,
}) => {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const pct = remainingPercent === null ? null : Math.min(100, Math.max(0, Math.round(remainingPercent)));
  const color = colorOverride || remainingColor(pct, providerType);
  const offset = circumference - (circumference * (pct ?? 0)) / 100;
  const big = size >= 120;

  return (
    <View style={[styles.container, { width: size, height: size, opacity: dimmed ? 0.55 : 1 }]}>
      <Svg width={size} height={size}>
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke={Colors.track}
          strokeWidth={strokeWidth}
          fill="none"
        />
        {pct !== null && pct > 0 && (
          <Circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            stroke={color}
            strokeWidth={strokeWidth}
            fill="none"
            strokeDasharray={`${circumference} ${circumference}`}
            strokeDashoffset={offset}
            strokeLinecap="round"
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        )}
      </Svg>
      <View style={styles.center}>
        <Text style={[styles.value, { fontSize: Math.round(size * (big ? 0.2 : 0.25)) }]}>
          {pct === null ? '—' : `${pct}%`}
        </Text>
        {size >= 60 && (
          <Text style={[styles.sublabel, big && { fontSize: 13, marginTop: 2 }]}>
            {pct === null ? 'no data' : sublabel}
          </Text>
        )}
      </View>
    </View>
  );
};

export interface DualRingProps {
  buckets?: QuotaBucket[];
  data?: DualRingData;
  size?: number;
  dimmed?: boolean;
  badge?: React.ReactNode;
  providerType?: ProviderType;
  showLabel?: boolean;
}

export const DualRing: React.FC<DualRingProps> = ({
  buckets,
  data: explicitData,
  size = 80,
  dimmed,
  badge,
  providerType,
  showLabel = true,
}) => {
  const data = explicitData ?? resolveRingWindows(buckets);
  const center = size / 2;

  // Geometry: outer ring ~7 stroke, inner ring ~8.5 stroke
  const outerStroke = size >= 120 ? Math.round(size * 0.075) : 7;
  const innerStroke = size >= 120 ? Math.round(size * 0.094 * 2) / 2 : 8.5;
  const gap = Math.max(3, Math.round(size * 0.04));

  const hasDual = Boolean(data.outer && data.inner);
  const singleStroke = innerStroke; // Single ring fallback uses the heavier stroke

  // Radii
  const rOuter = (size - (hasDual ? outerStroke : singleStroke)) / 2;
  const rInner = hasDual ? rOuter - outerStroke / 2 - gap - innerStroke / 2 : 0;

  // Outer ring data
  const outerPct = data.outer ? Math.min(100, Math.max(0, Math.round(data.outer.remaining))) : null;
  const cOuter = 2 * Math.PI * rOuter;
  const clampedOuterPct = outerPct === null || outerPct <= 0 ? 0 : Math.max(outerPct, 3);
  const offsetOuter = cOuter - (cOuter * clampedOuterPct) / 100;
  const capOuter: 'butt' | 'round' = outerPct !== null && (outerPct < 3 || outerPct > 97) ? 'butt' : 'round';
  const colorOuter = outerPct !== null ? severityColor(outerPct, providerType) : Colors.track;
  const trackOuterColor = outerPct === 0 ? SeverityTokens.exhausted.soft : Colors.track;

  // Inner ring data
  const innerPct = data.inner ? Math.min(100, Math.max(0, Math.round(data.inner.remaining))) : null;
  const cInner = 2 * Math.PI * rInner;
  const clampedInnerPct = innerPct === null || innerPct <= 0 ? 0 : Math.max(innerPct, 3);
  const offsetInner = cInner - (cInner * clampedInnerPct) / 100;
  const capInner: 'butt' | 'round' = innerPct !== null && (innerPct < 3 || innerPct > 97) ? 'butt' : 'round';
  const colorInner = innerPct !== null ? severityColor(innerPct, providerType) : Colors.track;
  const trackInnerColor = innerPct === 0 ? SeverityTokens.exhausted.soft : Colors.track;

  // Center display values
  const eff = data.effectiveRemaining;
  const effPct = eff === null ? null : Math.min(100, Math.max(0, Math.round(eff)));

  const valueColor =
    data.severity === 'exhausted'
      ? SeverityTokens.exhausted.ink
      : data.severity === 'critical'
      ? SeverityTokens.critical.ink
      : Colors.text;

  const sublabelText = data.binding ? `${data.binding.short} left` : 'no data';
  const a11y = ringA11yLabel(data);

  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={a11y}
      style={[styles.container, { width: size, height: size, opacity: dimmed ? 0.55 : 1 }]}
    >
      <Svg width={size} height={size}>
        {/* Outer track */}
        <Circle
          cx={center}
          cy={center}
          r={rOuter}
          stroke={trackOuterColor}
          strokeWidth={hasDual ? outerStroke : singleStroke}
          fill="none"
        />

        {/* Outer arc */}
        {outerPct !== null && outerPct > 0 && (
          <Circle
            cx={center}
            cy={center}
            r={rOuter}
            stroke={colorOuter}
            strokeWidth={hasDual ? outerStroke : singleStroke}
            fill="none"
            strokeDasharray={`${cOuter} ${cOuter}`}
            strokeDashoffset={offsetOuter}
            strokeLinecap={capOuter}
            transform={`rotate(-90 ${center} ${center})`}
          />
        )}

        {/* Inner ring (dual mode only) */}
        {hasDual && (
          <>
            <Circle
              cx={center}
              cy={center}
              r={rInner}
              stroke={trackInnerColor}
              strokeWidth={innerStroke}
              fill="none"
            />
            {innerPct !== null && innerPct > 0 && (
              <Circle
                cx={center}
                cy={center}
                r={rInner}
                stroke={colorInner}
                strokeWidth={innerStroke}
                fill="none"
                strokeDasharray={`${cInner} ${cInner}`}
                strokeDashoffset={offsetInner}
                strokeLinecap={capInner}
                transform={`rotate(-90 ${center} ${center})`}
              />
            )}
          </>
        )}
      </Svg>

      <View style={styles.center}>
        <Text
          style={[
            styles.value,
            {
              fontSize: Math.round(size * 0.22),
              color: valueColor,
            },
          ]}
        >
          {effPct === null ? '—' : `${effPct}%`}
        </Text>
        {showLabel && size >= 60 && (
          <Text style={[styles.sublabel, { fontSize: size >= 120 ? 12 : 9.5 }]}>
            {effPct === null ? 'no data' : sublabelText}
          </Text>
        )}
      </View>

      {badge && <View style={styles.badgeSlot}>{badge}</View>}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  center: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
  },
  value: {
    fontWeight: '800',
    color: Colors.text,
    letterSpacing: -0.6,
    fontVariant: ['tabular-nums'],
  },
  sublabel: {
    fontSize: 9.5,
    fontWeight: '600',
    color: Colors.textMuted,
    marginTop: -1,
  },
  badgeSlot: {
    position: 'absolute',
    top: -4,
    right: -4,
  },
});
