import React, { useState } from 'react';
import {
  Dimensions,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Check, Clock, Copy, ExternalLink, X } from 'lucide-react-native';
import { Colors, LAB_BRAND_PALETTES, PROVIDER_NAMES, Radius } from '../constants/theme';
import { AccountEntity, UsageSnapshot } from '../models/types';
import { AccountTelemetry, formatTokenCount } from '../services/telemetryService';
import { formatTimeRemaining } from '../utils/formatters';

export interface AccountDetailDrawerProps {
  visible: boolean;
  account: AccountEntity | null;
  snapshot?: UsageSnapshot;
  telemetry?: AccountTelemetry;
  onClose: () => void;
  onViewInFleet?: (provider: string, accountId: string) => void;
}

export const AccountDetailDrawer: React.FC<AccountDetailDrawerProps> = ({
  visible,
  account,
  snapshot,
  telemetry,
  onClose,
  onViewInFleet,
}) => {
  const [copied, setCopied] = useState(false);
  if (!account) return null;

  const brand = LAB_BRAND_PALETTES[account.providerType] || { primary: Colors.custom.primary };
  const providerName = PROVIDER_NAMES[account.providerType] || account.providerType;
  const buckets = snapshot?.buckets || [];
  const weekly = buckets.find((b) => b.windowType === 'weekly_7d') || buckets[0];
  const rolling = buckets.find((b) => b.windowType === 'session_5h') || buckets[1] || buckets[0];

  const weeklyRem = weekly?.remainingPercent ?? 100;
  const rollingRem = rolling?.remainingPercent ?? 100;

  const isExhausted = (snapshot?.status === 'ok' ? false : snapshot?.status === 'rate_limited') || weeklyRem <= 10 || rollingRem <= 10;
  const nearestReset = weekly?.resetsAt || rolling?.resetsAt;

  const handleCopyEmail = () => {
    const textToCopy = account.email || account.name;
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(textToCopy).catch(() => {});
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const slotId = telemetry?.slotId || `${account.providerType}_slot_01`;
  const proxyPort = telemetry?.proxyPort || 8317;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close drawer backdrop" />

        <View style={styles.drawerSheet}>
          {/* Header */}
          <View style={styles.header}>
            <View style={styles.headerLeft}>
              <View style={[styles.brandBadge, { backgroundColor: brand.primary }]}>
                <Text style={styles.brandBadgeText}>{providerName}</Text>
              </View>
              <Text style={styles.accountTitle} numberOfLines={1}>
                {account.name}
              </Text>
            </View>
            <TouchableOpacity onPress={onClose} hitSlop={12} style={styles.closeBtn} accessibilityLabel="Close account details">
              <X size={20} color={Colors.text} />
            </TouchableOpacity>
          </View>

          {/* Email row with 1-click copy */}
          <View style={styles.emailRow}>
            <Text style={styles.emailText} numberOfLines={1}>
              {account.email || 'No email associated'}
            </Text>
            {account.email && (
              <TouchableOpacity onPress={handleCopyEmail} style={styles.copyBtn} activeOpacity={0.7}>
                {copied ? (
                  <>
                    <Check size={14} color={Colors.normal} />
                    <Text style={[styles.copyBtnText, { color: Colors.normal }]}>Copied</Text>
                  </>
                ) : (
                  <>
                    <Copy size={14} color={Colors.textMuted} />
                    <Text style={styles.copyBtnText}>Copy</Text>
                  </>
                )}
              </TouchableOpacity>
            )}
          </View>

          {/* Real-time Status Banner */}
          <View style={[styles.statusBanner, isExhausted ? styles.statusBannerExhausted : styles.statusBannerHealthy]}>
            <View style={styles.statusIndicatorRow}>
              <View style={[styles.statusDot, { backgroundColor: isExhausted ? Colors.exhausted : Colors.normal }]} />
              <Text style={[styles.statusBannerText, { color: isExhausted ? Colors.exhausted : Colors.normal }]}>
                {isExhausted ? 'Cooldown Active' : 'Ready & Healthy'}
              </Text>
            </View>
            {nearestReset && (
              <View style={styles.countdownRow}>
                <Clock size={13} color={Colors.textMuted} />
                <Text style={styles.countdownText}>Resets in {formatTimeRemaining(nearestReset)}</Text>
              </View>
            )}
          </View>

          {/* Dual Quota Consumption Meters */}
          <View style={styles.metersSection}>
            {/* Meter 1: Weekly Quota Cap */}
            <View style={styles.meterContainer}>
              <View style={styles.meterHeader}>
                <Text style={styles.meterTitle}>Weekly Quota Cap</Text>
                <Text style={styles.meterPct}>{Math.round(weeklyRem)}% remaining</Text>
              </View>
              <View style={styles.meterTrack}>
                <View style={[styles.meterFill, { width: `${Math.round(weeklyRem)}%`, backgroundColor: brand.primary }]} />
              </View>
              <View style={styles.meterFooter}>
                <Text style={styles.meterFooterSub}>
                  {weekly?.resetsAt ? `Resets ${formatTimeRemaining(weekly.resetsAt)}` : '7-day rolling window'}
                </Text>
              </View>
            </View>

            {/* Meter 2: 5-Hour Rolling Limit */}
            <View style={styles.meterContainer}>
              <View style={styles.meterHeader}>
                <Text style={styles.meterTitle}>5-Hour Rolling Limit</Text>
                <Text style={styles.meterPct}>{Math.round(rollingRem)}% remaining</Text>
              </View>
              <View style={styles.meterTrack}>
                <View style={[styles.meterFill, { width: `${Math.round(rollingRem)}%`, backgroundColor: brand.primary }]} />
              </View>
              <View style={styles.meterFooter}>
                <Text style={styles.meterFooterSub}>
                  {rolling?.resetsAt ? `Resets in ${formatTimeRemaining(rolling.resetsAt)}` : 'Active session window'}
                </Text>
              </View>
            </View>
          </View>

          {/* Proxy / Telemetry Slot Details */}
          <View style={styles.proxyInfoCard}>
            <Text style={styles.proxyCardTitle}>Proxy Router Telemetry</Text>
            <View style={styles.proxyMetaRow}>
              <Text style={styles.proxyMetaLabel}>Auth Slot:</Text>
              <Text style={styles.proxyMetaValue}>{slotId}</Text>
            </View>
            <View style={styles.proxyMetaRow}>
              <Text style={styles.proxyMetaLabel}>Proxy Port:</Text>
              <Text style={styles.proxyMetaValue}>{proxyPort} (CLIProxy pool)</Text>
            </View>
            {telemetry && (
              <>
                <View style={styles.proxyMetaRow}>
                  <Text style={styles.proxyMetaLabel}>Total Routed:</Text>
                  <Text style={styles.proxyMetaValue}>
                    {formatTokenCount(telemetry.totalTokens)} tokens ({telemetry.proxySource || 'proxy'})
                  </Text>
                </View>
                <View style={styles.proxyMetaRow}>
                  <Text style={styles.proxyMetaLabel}>Prompt / Completion:</Text>
                  <Text style={styles.proxyMetaValue}>
                    {formatTokenCount(telemetry.promptTokens)} / {formatTokenCount(telemetry.completionTokens)}
                  </Text>
                </View>
                <View style={styles.proxyMetaRow}>
                  <Text style={styles.proxyMetaLabel}>Request Count:</Text>
                  <Text style={styles.proxyMetaValue}>{telemetry.requestCount} requests</Text>
                </View>
              </>
            )}
          </View>

          {/* Footer Navigation Button */}
          <TouchableOpacity
            style={styles.fleetNavBtn}
            activeOpacity={0.85}
            onPress={() => {
              onClose();
              onViewInFleet?.(account.providerType, account.id);
            }}
          >
            <Text style={styles.fleetNavBtnText}>View in Fleet Tab</Text>
            <ExternalLink size={16} color="#ffffff" />
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
};

const screenWidth = Dimensions.get('window').width;
const isDesktop = screenWidth >= 960;

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
    justifyContent: isDesktop ? 'flex-end' : 'flex-end',
    flexDirection: isDesktop ? 'row' : 'column',
  },
  backdrop: {
    ...StyleSheet.absoluteFill,
  },
  drawerSheet: {
    width: isDesktop ? 440 : '100%',
    maxHeight: isDesktop ? '100%' : '88%',
    backgroundColor: Colors.card,
    borderTopLeftRadius: Radius.xl,
    borderTopRightRadius: isDesktop ? 0 : Radius.xl,
    borderBottomLeftRadius: isDesktop ? Radius.xl : 0,
    padding: 24,
    shadowColor: '#000',
    shadowOffset: { width: isDesktop ? -4 : 0, height: isDesktop ? 0 : -4 },
    shadowOpacity: 0.15,
    shadowRadius: 16,
    elevation: 20,
    borderLeftWidth: 1,
    borderColor: Colors.border,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flex: 1,
  },
  brandBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: Radius.xs,
  },
  brandBadgeText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '700',
  },
  accountTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: Colors.text,
    flex: 1,
  },
  closeBtn: {
    padding: 6,
    borderRadius: Radius.full,
    backgroundColor: Colors.cardHighlight,
  },
  emailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  emailText: {
    fontSize: 13,
    color: Colors.textMuted,
    flex: 1,
  },
  copyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: Colors.cardHighlight,
    borderRadius: Radius.xs,
  },
  copyBtnText: {
    fontSize: 12,
    fontWeight: '600',
    color: Colors.textMuted,
  },
  statusBanner: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 12,
    borderRadius: Radius.md,
    marginBottom: 18,
  },
  statusBannerHealthy: {
    backgroundColor: Colors.normalSoft,
  },
  statusBannerExhausted: {
    backgroundColor: Colors.exhaustedSoft,
  },
  statusIndicatorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statusBannerText: {
    fontSize: 13,
    fontWeight: '700',
  },
  countdownRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  countdownText: {
    fontSize: 12,
    color: Colors.textMuted,
  },
  metersSection: {
    gap: 14,
    marginBottom: 18,
  },
  meterContainer: {
    backgroundColor: Colors.cardHighlight,
    padding: 12,
    borderRadius: Radius.md,
  },
  meterHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  meterTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: Colors.text,
  },
  meterPct: {
    fontSize: 13,
    fontWeight: '700',
    color: Colors.text,
  },
  meterTrack: {
    height: 8,
    backgroundColor: Colors.track,
    borderRadius: 4,
    overflow: 'hidden',
    marginBottom: 4,
  },
  meterFill: {
    height: '100%',
    borderRadius: 4,
  },
  meterFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  meterFooterSub: {
    fontSize: 11,
    color: Colors.textMuted,
  },
  proxyInfoCard: {
    padding: 12,
    backgroundColor: Colors.cardHighlight,
    borderRadius: Radius.md,
    marginBottom: 20,
    gap: 6,
  },
  proxyCardTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: Colors.text,
    marginBottom: 4,
  },
  proxyMetaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  proxyMetaLabel: {
    fontSize: 12,
    color: Colors.textMuted,
  },
  proxyMetaValue: {
    fontSize: 12,
    fontWeight: '600',
    color: Colors.text,
  },
  fleetNavBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: Colors.ink,
    paddingVertical: 14,
    borderRadius: Radius.md,
    marginTop: 'auto',
  },
  fleetNavBtnText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '700',
  },
});
