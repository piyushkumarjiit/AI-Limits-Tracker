import React, { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { History } from 'lucide-react-native';
import { BarChart, MiniBars, MiniLine } from '../../components/Charts';
import { FamilyCard } from '../../components/FamilyCard';
import { Card, EmptyState, ScreenHeader, SectionTitle, Segmented } from '../../components/ui';
import { accountChartColor, Colors } from '../../constants/theme';
import { UsageHistoryPoint } from '../../models/types';
import { groupFamilies } from '../../services/capacity';
import { getHistorySince } from '../../services/db';
import { bindingBucket } from '../../services/notificationService';
import { useAppStore } from '../../store/useAppStore';
import { MONTHS_SHORT, WEEKDAYS_SHORT } from '../../utils/formatters';

type Range = '7' | '30' | '90' | '365';

const RANGE_GROUPS: Record<Range, { groups: number; daysPerGroup: number }> = {
  '7': { groups: 7, daysPerGroup: 1 },
  '30': { groups: 10, daysPerGroup: 3 },
  '90': { groups: 13, daysPerGroup: 7 },
  '365': { groups: 12, daysPerGroup: 365 / 12 },
};

export default function AnalyticsScreen() {
  const router = useRouter();
  const { accounts, snapshots } = useAppStore();
  const [range, setRange] = useState<Range>('7');
  const [points, setPoints] = useState<UsageHistoryPoint[]>([]);

  const days = Number(range);
  useEffect(() => {
    getHistorySince(new Date(Date.now() - days * 86400000).toISOString())
      .then(setPoints)
      .catch(() => setPoints([]));
  }, [days, snapshots]);

  const colorFor = useMemo(() => {
    const seen: Record<string, number> = {};
    const map: Record<string, string> = {};
    for (const a of accounts) {
      const i = seen[a.providerType] || 0;
      seen[a.providerType] = i + 1;
      map[a.id] = accountChartColor(a.providerType, i);
    }
    return map;
  }, [accounts]);

  const data = useMemo(() => {
    const { groups, daysPerGroup } = RANGE_GROUPS[range];
    const now = new Date();
    now.setHours(23, 59, 59, 999);
    const end = now.getTime();
    const groupMs = daysPerGroup * 86400000;
    const start = end - groups * groupMs;

    const labels: string[] = [];
    for (let g = 0; g < groups; g++) {
      const d = new Date(start + g * groupMs + groupMs / 2);
      if (range === '7') labels.push(WEEKDAYS_SHORT[d.getDay()]);
      else if (range === '365') labels.push(MONTHS_SHORT[d.getMonth()].slice(0, 3));
      else labels.push(g % 2 === 0 ? `${d.getDate()}` : '');
    }

    // Per-account peak load in each period
    const peaks: Record<string, Array<number | null>> = {};
    const allValues: number[] = [];
    const dailyAvg: Record<number, number[]> = {};
    for (const p of points) {
      if (p.primaryUtilization == null) continue;
      const t = new Date(p.fetchedAt).getTime();
      const g = Math.floor((t - start) / groupMs);
      if (g < 0 || g >= groups) continue;
      peaks[p.accountId] = peaks[p.accountId] || new Array(groups).fill(null);
      peaks[p.accountId][g] = Math.max(peaks[p.accountId][g] ?? 0, p.primaryUtilization);
      allValues.push(p.primaryUtilization);
      (dailyAvg[g] = dailyAvg[g] || []).push(p.primaryUtilization);
    }

    const series = accounts
      .filter((a) => peaks[a.id])
      .map((a) => ({ color: colorFor[a.id], values: peaks[a.id] }));

    const avgLine: number[] = [];
    for (let g = 0; g < groups; g++) {
      const arr = dailyAvg[g];
      if (arr?.length) avgLine.push(arr.reduce((x, y) => x + y, 0) / arr.length);
    }
    const peakBars = Array.from({ length: groups }, (_, g) =>
      dailyAvg[g]?.length ? Math.max(...dailyAvg[g]) : null
    );

    const avg = allValues.length ? Math.round(allValues.reduce((a, b) => a + b, 0) / allValues.length) : null;
    const peak = allValues.length ? Math.round(Math.max(...allValues)) : null;
    return { labels, series, avg, peak, avgLine, peakBars, measurements: allValues.length };
  }, [points, range, accounts, colorFor]);

  const families = useMemo(() => {
    const enriched = accounts.map((a) => ({
      ...a,
      latestSnapshot: snapshots[a.id],
    }));
    return groupFamilies(enriched);
  }, [accounts, snapshots]);

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <ScreenHeader
          large
          title="Analytics"
          subtitle="Usage across all accounts"
          right={
            <TouchableOpacity onPress={() => router.push('/history')} hitSlop={10}>
              <History size={21} color={Colors.text} />
            </TouchableOpacity>
          }
        />

        <Segmented
          value={range}
          onChange={setRange}
          style={{ marginBottom: 16 }}
          options={[
            { key: '7', label: '7D' },
            { key: '30', label: '30D' },
            { key: '90', label: '3M' },
            { key: '365', label: '1Y' },
          ]}
        />

        {accounts.length === 0 ? (
          <EmptyState title="No data" text="Add an account — statistics will start collecting from the first refresh." />
        ) : (
          <>
            <View style={styles.tiles}>
              <Card style={styles.tile}>
                <Text style={styles.tileLabel}>Average load</Text>
                <Text style={styles.tileValue}>{data.avg === null ? '—' : `${data.avg}%`}</Text>
                <MiniLine values={data.avgLine} />
              </Card>
              <Card style={styles.tile}>
                <Text style={styles.tileLabel}>Peak load</Text>
                <Text style={styles.tileValue}>{data.peak === null ? '—' : `${data.peak}%`}</Text>
                <MiniBars values={data.peakBars.slice(-12)} color="#6b6962" height={30} />
              </Card>
            </View>

            <SectionTitle>Family quota distribution</SectionTitle>
            {families.length === 0 ? (
              <Card>
                <Text style={styles.emptyFamilyText}>No current quota data</Text>
              </Card>
            ) : (
              <View style={styles.familyGrid}>
                {families.map((fam) => (
                  <FamilyCard
                    key={fam.family}
                    summary={fam}
                    colors={colorFor}
                    variant="detailed"
                  />
                ))}
              </View>
            )}

            <SectionTitle>Peak load by {range === '7' ? 'day' : 'period'}</SectionTitle>
            <Card>
              {data.series.length ? (
                <BarChart labels={data.labels} series={data.series} stacked height={150} />
              ) : (
                <Text style={styles.legendEmpty}>No measurements for this period yet.</Text>
              )}
            </Card>
            <Text style={styles.footnote}>
              Sum of peak session-window % across all accounts · measurements: {data.measurements}
            </Text>
          </>
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
  tiles: {
    flexDirection: 'row',
    gap: 10,
  },
  tile: {
    flex: 1,
    padding: 14,
    gap: 6,
  },
  tileLabel: {
    fontSize: 12,
    color: Colors.textMuted,
  },
  tileValue: {
    fontSize: 24,
    fontWeight: '800',
    color: Colors.text,
    letterSpacing: -0.6,
  },
  familyGrid: {
    gap: 12,
  },
  emptyFamilyText: {
    fontSize: 12.5,
    color: Colors.textMuted,
    textAlign: 'center',
    paddingVertical: 16,
  },
  legendEmpty: {
    fontSize: 12.5,
    color: Colors.textMuted,
    textAlign: 'center',
    paddingVertical: 16,
  },
  footnote: {
    fontSize: 11,
    color: Colors.textSubtle,
    textAlign: 'center',
    marginTop: 10,
  },
});
