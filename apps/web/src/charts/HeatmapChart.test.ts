import { describe, expect, it } from 'vitest';
import { dayOfWeekFromDateKey } from './HeatmapChart.js';

describe('dayOfWeekFromDateKey', () => {
  it('parses YYYY-MM-DD as a local calendar date, not UTC midnight', () => {
    expect(dayOfWeekFromDateKey('2026-04-27')).toBe(1);
  });
});
