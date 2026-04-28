/**
 * ECharts tree-shaking registration.
 *
 * Import this module once (in any chart component) before any ECharts instance
 * is created. It registers the minimal component set needed by this dashboard.
 *
 * Design: reading --color-primary at runtime (via getComputedStyle) allows all
 * chart option builders to stay in sync with the active CSS theme token without
 * hardcoding any color value.
 */

import { LineChart, PieChart } from 'echarts/charts';
import {
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
} from 'echarts/components';
import * as echarts from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';

// Register once at module evaluation time (safe to call multiple times — ECharts deduplicates)
echarts.use([
  LineChart,
  PieChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  TitleComponent,
  CanvasRenderer,
]);

// ---------------------------------------------------------------------------
// Token reader — resolves CSS custom properties at call time so dark mode
// flips are respected when charts re-evaluate options.
// ---------------------------------------------------------------------------

function getCSSToken(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const val = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return val.length > 0 ? val : fallback;
}

// ---------------------------------------------------------------------------
// Palette helpers — called inside chart option memos (dependencies on resolvedTheme)
// ---------------------------------------------------------------------------

/** Returns the primary accent color string (CSS token value). */
export function primaryColor(): string {
  return getCSSToken('--color-primary', 'oklch(0.49 0.16 255)');
}

/** Returns the muted text color for axis labels etc. */
export function mutedColor(): string {
  return getCSSToken('--color-gray-500', 'oklch(0.52 0 0)');
}

/** Returns the grid/border line color. */
export function gridColor(): string {
  return getCSSToken('--color-gray-200', 'oklch(0.87 0 0)');
}

/**
 * Returns the card surface color for DARK mode (near-black gray-900).
 *
 * Use this when building a chart background intended for a dark theme.
 * For light-mode surfaces use surfaceColorLight().
 *
 * Note: the original `surfaceColor()` export was renamed to make its
 * dark-mode bias explicit. No chart currently calls this helper — charts
 * use backgroundColor:'transparent' instead.
 */
export function surfaceColorDark(): string {
  return getCSSToken('--color-gray-900', 'oklch(0.16 0 0)');
}

/**
 * Returns the card surface color for LIGHT mode (near-white gray-50).
 */
export function surfaceColorLight(): string {
  return getCSSToken('--color-gray-50', 'oklch(0.97 0 0)');
}

/**
 * @deprecated Use surfaceColorDark() or surfaceColorLight() explicitly.
 * This alias is kept for backwards compatibility but always returns the
 * dark-mode surface color regardless of the active theme.
 */
export function surfaceColor(): string {
  return surfaceColorDark();
}

// ---------------------------------------------------------------------------
// Shared ECharts base option — used as the starting point for all charts
// ---------------------------------------------------------------------------

export interface EchartsBaseOption {
  backgroundColor: string;
  textStyle: { color: string; fontFamily: string };
  grid: { borderColor: string };
}

/**
 * Returns the shared ECharts base option object.
 * Call this inside a useMemo that depends on `resolvedTheme` so charts
 * re-evaluate when the theme flips.
 *
 * @param isDark - pass `resolvedTheme === 'dark'` from useTheme()
 */
export function getBaseOption(isDark: boolean): EchartsBaseOption {
  return {
    backgroundColor: 'transparent',
    textStyle: {
      color: isDark
        ? getCSSToken('--color-gray-400', 'oklch(0.65 0 0)')
        : getCSSToken('--color-gray-500', 'oklch(0.52 0 0)'),
      fontFamily:
        'system-ui, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    },
    grid: {
      borderColor: isDark
        ? getCSSToken('--color-gray-800', 'oklch(0.24 0 0)')
        : getCSSToken('--color-gray-200', 'oklch(0.87 0 0)'),
    },
  };
}

// Re-export the core echarts object for chart components that need it directly
export { echarts };
