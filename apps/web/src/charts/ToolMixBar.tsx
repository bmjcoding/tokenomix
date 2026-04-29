/**
 * ToolMixBar — donut chart for tool invocation distribution.
 *
 * Takes ToolBucket[], sorts descending by count, shows top 6 + "other".
 * Uses a pie series (inner radius ~62%, outer radius ~88%) for compact display.
 * Center label shows total invocation count and "Total calls" underneath.
 * Slices use a 6-step blue ramp: darkest slice = most-used tool.
 * Tooltip shows count and errorRate on hover.
 */

import type { ToolBucket } from '@tokenomix/shared';
import ReactECharts from 'echarts-for-react';
import { useMemo } from 'react';
import { getBaseOption, gridColor } from '../lib/echarts.js';
import { useTheme } from '../providers/ThemeProvider.js';

interface ToolMixBarProps {
  data: ToolBucket[];
  height?: number;
}

const MAX_TOOLS = 6;

/**
 * 6-step blue ramp for donut slices.
 * Index 0 = darkest (most-used tool), index 5 = lightest.
 * Separate ramps for dark and light mode.
 */
function getBlueRamp(isDark: boolean): string[] {
  if (isDark) {
    return [
      'oklch(0.40 0.19 255)', // darkest — primary-dark
      'oklch(0.49 0.16 255)', // primary
      'oklch(0.58 0.14 255)', // mid-blue
      'oklch(0.66 0.13 255)', // lighter
      'oklch(0.73 0.12 255)', // even lighter
      'oklch(0.78 0.11 255)', // lightest — raised chroma to stay above desaturation threshold on gray-900
    ];
  }
  return [
    'oklch(0.40 0.19 255)', // darkest
    'oklch(0.49 0.16 255)', // primary
    'oklch(0.58 0.14 255)', // mid-blue
    'oklch(0.66 0.13 255)', // lighter
    'oklch(0.73 0.12 255)', // even lighter
    'oklch(0.85 0.09 255)', // lightest
  ];
}

export function ToolMixBar({ data, height = 240 }: ToolMixBarProps) {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

  const option = useMemo(() => {
    const base = getBaseOption(isDark);
    const grid = gridColor();
    const ramp = getBlueRamp(isDark);

    // Sort descending by count
    const sorted = [...data].sort((a, b) => b.count - a.count);

    // Build top-6 + "other" rollup
    let slices: Array<{ name: string; value: number; errorRate: number }>;
    if (sorted.length <= MAX_TOOLS) {
      slices = sorted.map((t) => ({ name: t.toolName, value: t.count, errorRate: t.errorRate }));
    } else {
      const top = sorted.slice(0, MAX_TOOLS);
      const rest = sorted.slice(MAX_TOOLS);
      const otherCount = rest.reduce((s, t) => s + t.count, 0);
      const otherErrors = rest.reduce((s, t) => s + t.errorCount, 0);
      const otherErrorRate = otherCount > 0 ? otherErrors / otherCount : 0;
      slices = [
        ...top.map((t) => ({ name: t.toolName, value: t.count, errorRate: t.errorRate })),
        { name: 'other', value: otherCount, errorRate: otherErrorRate },
      ];
    }

    const totalCount = slices.reduce((s, sl) => s + sl.value, 0);

    // Assign colors from ramp; clamp index to ramp length
    const coloredSlices = slices.map((sl, i) => ({
      name: sl.name,
      value: sl.value,
      errorRate: sl.errorRate,
      itemStyle: {
        color: ramp[Math.min(i, ramp.length - 1)],
      },
    }));

    const textColor = isDark ? 'oklch(0.97 0 0)' : 'oklch(0.13 0 0)';
    const mutedTextColor = isDark ? 'oklch(0.65 0 0)' : 'oklch(0.52 0 0)';

    return {
      ...base,
      tooltip: {
        trigger: 'item' as const,
        formatter: (params: {
          name: string;
          value: number;
          percent: number;
          data: { errorRate: number };
        }) => {
          const pct = params.percent.toFixed(1);
          const errPct = (params.data.errorRate * 100).toFixed(1);
          return `${params.name}: ${params.value.toLocaleString()} calls (${pct}%)<br/>Error rate: ${errPct}%`;
        },
        backgroundColor: isDark ? 'oklch(0.10 0 0)' : 'oklch(0.99 0.005 90)',
        borderColor: grid,
        textStyle: { color: base.textStyle.color },
      },
      graphic: [
        {
          type: 'text',
          left: 'center',
          top: 'middle',
          style: {
            text: totalCount.toLocaleString(),
            fill: textColor,
            fontSize: 16,
            fontWeight: 'bold',
            fontFamily: base.textStyle.fontFamily,
            textAlign: 'center',
          },
          z: 10,
        },
        {
          type: 'text',
          left: 'center',
          top: '57%',
          style: {
            text: 'Total calls',
            fill: mutedTextColor,
            fontSize: 11,
            fontFamily: base.textStyle.fontFamily,
            textAlign: 'center',
          },
          z: 10,
        },
      ],
      series: [
        {
          type: 'pie' as const,
          radius: ['62%', '88%'],
          center: ['50%', '50%'],
          data: coloredSlices,
          label: { show: false },
          labelLine: { show: false },
          emphasis: {
            scale: false,
            focus: 'self',
            itemStyle: {
              shadowBlur: 8,
              shadowColor: isDark ? 'oklch(0.10 0 0 / 60%)' : 'oklch(0.70 0 0 / 40%)',
              borderColor: isDark ? 'oklch(0.24 0 0)' : 'oklch(0.87 0 0)',
              borderWidth: 1,
            },
          },
        },
      ],
    };
  }, [data, isDark]);

  return <ReactECharts option={option} style={{ height: `${height}px`, width: '100%' }} />;
}
