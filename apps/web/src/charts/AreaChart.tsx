/**
 * AreaChart — smooth gradient area chart for time-series data.
 *
 * Renders a DailyBucket[] as a smooth filled area chart.
 * Re-evaluates ECharts options when resolvedTheme changes so dark mode reflows
 * correctly without a page reload.
 */

import type { DailyBucket } from '@tokenomix/shared';
import ReactECharts from 'echarts-for-react';
import { useMemo } from 'react';
import {
  getBaseOption,
  gridColor,
  mutedColor,
  primaryColor,
  surfaceColorDark,
  surfaceColorLight,
} from '../lib/echarts.js';
import { useTheme } from '../providers/ThemeProvider.js';

export type AreaField = 'costUsd' | 'inputTokens' | 'outputTokens';

interface AreaChartProps {
  data: DailyBucket[];
  field: AreaField;
  height?: number;
  /**
   * Optional x-axis label formatter. When provided, replaces the default
   * `val.slice(5)` formatter (which produces MM-DD from YYYY-MM-DD date strings).
   *
   * Use case: 24h period — pass `(raw) => raw.slice(11, 16)` to extract HH:00
   * from synthetic ISO timestamp strings (`YYYY-MM-DDTHH:00`).
   *
   * When absent, the existing MM-DD default is preserved, so all existing
   * callers remain unaffected.
   */
  xAxisLabelFormat?: (raw: string) => string;
}

const FIELD_LABELS: Record<AreaField, string> = {
  costUsd: 'Cost (USD)',
  inputTokens: 'Input Tokens',
  outputTokens: 'Output Tokens',
};

function formatValue(field: AreaField, v: number): string {
  if (field === 'costUsd') return `$${v.toFixed(2)}`;
  return v.toLocaleString();
}

export function AreaChart({ data, field, height = 220, xAxisLabelFormat }: AreaChartProps) {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

  const option = useMemo(() => {
    const base = getBaseOption(isDark);
    const primary = primaryColor();
    const muted = mutedColor();
    const grid = gridColor();

    const dates = data.map((d) => d.date);
    const values = data.map((d) => {
      if (field === 'costUsd') return d.costUsd;
      if (field === 'inputTokens') return d.inputTokens;
      return d.outputTokens;
    });

    return {
      ...base,
      tooltip: {
        trigger: 'axis',
        axisPointer: {
          type: 'line',
          lineStyle: { color: grid, type: 'dashed', width: 1 },
        },
        formatter: (params: unknown) => {
          const items = params as Array<{ name: string; value: number }>;
          if (!items[0]) return '';
          return `${items[0].name}<br/>${FIELD_LABELS[field]}: ${formatValue(field, items[0].value)}`;
        },
        backgroundColor: isDark ? surfaceColorDark() : surfaceColorLight(),
        borderColor: grid,
        textStyle: { color: base.textStyle.color },
      },
      grid: {
        left: 24,
        right: 24,
        top: 8,
        bottom: 32,
        containLabel: true,
      },
      xAxis: {
        type: 'category' as const,
        data: dates,
        boundaryGap: false,
        axisLine: { lineStyle: { color: grid } },
        axisTick: { show: false },
        axisLabel: {
          color: muted,
          fontSize: 11,
          // interval is a fallback; hideOverlap (below) is authoritative when set
          interval: Math.max(0, Math.floor(dates.length / 6) - 1),
          formatter: xAxisLabelFormat ?? ((val: string) => val.slice(5)), // MM-DD default
          hideOverlap: true,
          margin: 6,
        },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value' as const,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: {
          color: muted,
          fontSize: 11,
          formatter: (val: number) =>
            field === 'costUsd'
              ? `$${val.toFixed(2)}`
              : val >= 1000
                ? `${(val / 1000).toFixed(0)}k`
                : String(val),
        },
        splitLine: { lineStyle: { color: grid, type: 'dashed' as const } },
      },
      series: [
        {
          name: FIELD_LABELS[field],
          type: 'line' as const,
          data: values,
          smooth: true,
          smoothMonotone: 'x' as const,
          symbol: 'none',
          lineStyle: { color: primary, width: 2 },
          itemStyle: { color: primary },
          // Use ECharts' explicit `opacity` field rather than hex-alpha suffixes appended to OKLCH strings.
          // The hex-suffix form (e.g. `oklch(...)66`) is not valid CSS and was historically
          // tolerated by ECharts only as an undocumented quirk.
          areaStyle: {
            color: primary,
            opacity: 0.25,
          },
          // Prevent ECharts blurScope from dimming the series when the tooltip
          // axis pointer is active — without this the line+fill vanish on hover.
          emphasis: { disabled: true },
          blur: { areaStyle: { opacity: 0.25 } },
        },
      ],
    };
  }, [data, field, isDark, xAxisLabelFormat]);

  return <ReactECharts option={option} style={{ height: `${height}px`, width: '100%' }} notMerge />;
}
