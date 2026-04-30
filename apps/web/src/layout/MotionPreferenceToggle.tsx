/**
 * MotionPreferenceToggle — labeled segmented-pill for animation preference.
 *
 * Replaces the cycling icon button. The label "Motion" sits to the left in a
 * fixed-width span so all rows in FloatingControls align.
 */

import {
  type MotionPreference,
  useMotionPreference,
} from '../providers/MotionPreferenceProvider.js';
import { SegmentedToggle } from '../ui/SegmentedToggle.js';

const MOTION_OPTIONS: { value: MotionPreference; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'reduced', label: 'Reduced' },
  { value: 'full', label: 'Full' },
];

export default function MotionPreferenceToggle() {
  const { motionPreference, setMotionPreference } = useMotionPreference();

  return (
    <div className="flex items-center gap-3">
      <span className="w-16 text-xs font-medium text-gray-600 dark:text-gray-400">Motion</span>
      <SegmentedToggle<MotionPreference>
        ariaLabel="Animation preference"
        options={MOTION_OPTIONS}
        value={motionPreference}
        onChange={setMotionPreference}
        size="sm"
        accent="achromatic"
      />
    </div>
  );
}
