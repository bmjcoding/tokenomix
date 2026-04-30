/**
 * RefreshModeToggle — labeled segmented-pill for data refresh cadence.
 *
 * Replaces the cycling icon button. The label "Refresh" sits to the left in a
 * fixed-width span so all rows in FloatingControls align.
 */

import { type RefreshMode, useRefreshMode } from '../providers/RefreshModeProvider.js';
import { SegmentedToggle } from '../ui/SegmentedToggle.js';

const REFRESH_OPTIONS: { value: RefreshMode; label: string }[] = [
  { value: 'realtime', label: 'Real-time' },
  { value: 'minute', label: '1-min Interval' },
];

export default function RefreshModeToggle() {
  const { refreshMode, setRefreshMode } = useRefreshMode();

  return (
    <div className="flex items-center gap-3">
      <span className="w-16 text-xs font-medium text-gray-600 dark:text-gray-400">Refresh</span>
      <SegmentedToggle<RefreshMode>
        ariaLabel="Data refresh cadence"
        options={REFRESH_OPTIONS}
        value={refreshMode}
        onChange={setRefreshMode}
        size="sm"
        accent="achromatic"
      />
    </div>
  );
}
