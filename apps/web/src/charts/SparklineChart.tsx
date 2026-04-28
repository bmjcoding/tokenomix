/**
 * SparklineChart — minimal inline trend line for KPI cards.
 *
 * No axes, no grid, no legend, no tooltip. Just a smooth line showing trend.
 * Height is small (default 48px) so it fits inside a MetricCard.
 */

import ReactECharts from 'echarts-for-react';
import { useMemo } from 'react';
import { primaryColor } from '../lib/echarts.js';
import { useTheme } from '../providers/ThemeProvider.js';

interface SparklineChartProps {
  data: number[];
  height?: number;
}

export function SparklineChart({ data, height = 48 }: SparklineChartProps) {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

  // Resolve the primary color string inside the memo so it is used directly
  // in the option object. `primaryColor()` reads the CSS token at call time —
  // the function reference itself does not change, so Biome sees isDark as an
  // extra dep. We keep it intentionally: when the theme flips, isDark changes
  // which triggers a re-run that re-reads the token for the new theme.
  // biome-ignore lint/correctness/useExhaustiveDependencies: isDark is listed intentionally — primaryColor() reads a CSS token at call time and must re-run on theme change even though the function reference is stable
  const primary = useMemo(() => primaryColor(), [isDark]);

  const option = useMemo(() => {
    return {
      backgroundColor: 'transparent',
      // Purely presentational — no tooltip, no hover interactivity.
      tooltip: { show: false },
      grid: { left: 0, right: 0, top: 0, bottom: 0 },
      xAxis: { type: 'category' as const, show: false },
      yAxis: { type: 'value' as const, show: false },
      series: [
        {
          type: 'line' as const,
          data,
          smooth: true,
          // No markers at any time (including hover).
          symbol: 'none',
          // Do not propagate mouse events to this series.
          silent: true,
          // Disable hover state styling changes.
          emphasis: { disabled: true },
          lineStyle: { color: primary, width: 1.5, opacity: 0.8 },
          itemStyle: { color: primary },
          // Use ECharts opacity rather than appending hex alpha suffixes to
          // OKLCH strings. Hex-suffix notation (e.g. oklch(...)40) is not valid
          // CSS; ECharts accepts it internally but it is fragile and misleading.
          areaStyle: {
            color: primary,
            opacity: 0.2,
          },
        },
      ],
    };
  }, [data, primary]);

  // Wrap in aria-hidden so screen readers skip the decorative canvas element.
  // ReactECharts does not forward arbitrary props to the canvas, so the wrapper
  // div is the correct attachment point.
  return (
    <div aria-hidden="true">
      <ReactECharts option={option} style={{ height: `${height}px`, width: '100%' }} notMerge />
    </div>
  );
}
