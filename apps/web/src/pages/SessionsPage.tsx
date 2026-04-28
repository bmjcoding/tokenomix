/**
 * SessionsPage — full sessions table (limit 50) with search filter.
 */

import type { SinceOption } from '@tokenomix/shared';
import { useState } from 'react';
import { TopSessionsTable } from '../panels/TopSessionsTable.js';
import { Button } from '../ui/Button.js';

export default function SessionsPage() {
  const [since, setSince] = useState<SinceOption>('30d');

  const sinceOptions: Array<{ value: SinceOption; label: string }> = [
    { value: '7d', label: '7d' },
    { value: '30d', label: '30d' },
    { value: 'all', label: 'All time' },
  ];

  return (
    <div className="space-y-6 py-6 px-4 sm:px-6 lg:px-8 max-w-screen-xl">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-bold tracking-tight text-gray-950 dark:text-white">
          Sessions
        </h1>
        {/* biome-ignore lint/a11y/useSemanticElements: role=group with aria-label is the canonical toolbar buttongroup pattern; <fieldset> would impose default browser visual styling */}
        <div className="flex items-center gap-1" role="group" aria-label="Time period">
          {sinceOptions.map((opt) => (
            <Button
              key={opt.value}
              variant={since === opt.value ? 'primary' : 'ghost'}
              size="sm"
              onClick={() => setSince(opt.value)}
              aria-pressed={since === opt.value}
            >
              {opt.label}
            </Button>
          ))}
        </div>
      </div>
      <TopSessionsTable limit={50} since={since} />
    </div>
  );
}
