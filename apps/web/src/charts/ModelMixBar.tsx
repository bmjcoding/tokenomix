/**
 * ModelMixBar — donut chart for model cost distribution.
 *
 * @deprecated filename — kept for compatibility; component is a donut.
 *
 * Takes ModelBucket[], sorts descending by costUsd, shows top 6 + "other".
 * Uses a pie series (inner radius ~62%, outer radius ~88%) for compact display.
 * Center label shows total cost and "Total cost" underneath.
 * Slices use a 5-step blue ramp: darkest slice = highest cost model.
 */

import type { ModelBucket } from '@tokenomix/shared';
import ReactECharts from 'echarts-for-react';
import { useMemo } from 'react';
import { getBaseOption, gridColor } from '../lib/echarts.js';
import { useTheme } from '../providers/ThemeProvider.js';

interface ModelMixBarProps {
  data: ModelBucket[];
  height?: number;
}

const MAX_MODELS = 6;

/**
 * 5-step blue ramp for donut slices.
 * Index 0 = darkest (highest cost), index 4 = lightest (lowest cost).
 * Separate ramps for dark and light mode.
 */
function getBlueRamp(isDark: boolean): string[] {
  if (isDark) {
    return [
      'oklch(0.40 0.19 255)', // darkest — primary-dark
      'oklch(0.49 0.16 255)', // primary
      'oklch(0.60 0.15 255)', // mid-blue
      'oklch(0.72 0.13 255)', // lighter
      'oklch(0.78 0.12 255)', // lightest — raised chroma to stay above desaturation threshold on gray-900
    ];
  }
  return [
    'oklch(0.40 0.19 255)', // darkest
    'oklch(0.49 0.16 255)', // primary
    'oklch(0.60 0.15 255)', // mid-blue
    'oklch(0.72 0.13 255)', // lighter
    'oklch(0.85 0.09 255)', // lightest
  ];
}

/** Format a dollar value with commas and 2 decimal places, e.g. $2,769.84 */
function formatDollar(value: number): string {
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function ModelMixBar({ data, height = 240 }: ModelMixBarProps) {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

  const option = useMemo(() => {
    const base = getBaseOption(isDark);
    const grid = gridColor();
    const ramp = getBlueRamp(isDark);

    // Sort descending by costUsd
    const sorted = [...data].sort((a, b) => b.costUsd - a.costUsd);

    // Build top-6 + "other" rollup
    let slices: Array<{ name: string; value: number }>;
    if (sorted.length <= MAX_MODELS) {
      slices = sorted.map((m) => ({ name: m.modelFamily, value: m.costUsd }));
    } else {
      const top = sorted.slice(0, MAX_MODELS);
      const rest = sorted.slice(MAX_MODELS);
      const otherCost = rest.reduce((s, m) => s + m.costUsd, 0);
      slices = [
        ...top.map((m) => ({ name: m.modelFamily, value: m.costUsd })),
        { name: 'other', value: otherCost },
      ];
    }

    const totalCost = slices.reduce((s, sl) => s + sl.value, 0);

    // Assign colors from ramp; clamp index to ramp length
    const coloredSlices = slices.map((sl, i) => ({
      ...sl,
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
        formatter: (params: { name: string; value: number; percent: number }) => {
          const pct = params.percent.toFixed(1);
          return `${params.name}: ${formatDollar(params.value)} (${pct}%)`;
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
            text: formatDollar(totalCost),
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
            text: 'Total cost',
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
          // emphasis.disabled: completely turns off ECharts' default hover emphasis,
          // which (despite focus:'none') was still fading non-hovered slices to near-zero
          // opacity in ECharts 6. The tooltip (top-level config) still fires on hover.
          emphasis: { disabled: true },
          // blur defensively forces all non-hovered slices to keep their original color
          // at full opacity if any future config change re-enables emphasis behavior.
          blur: {
            itemStyle: { opacity: 1 },
          },
        },
      ],
    };
  }, [data, isDark]);

  return <ReactECharts option={option} style={{ height: `${height}px`, width: '100%' }} notMerge />;
}
