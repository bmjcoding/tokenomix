import type { UsageSourceProviderFilter } from '@tokenomix/shared';

const POSITIVE_INTEGER_RE = /^[1-9]\d*$/;

export function parsePositiveIntegerParam(raw: string | undefined): number | null | undefined {
  if (raw === undefined) return undefined;
  if (!POSITIVE_INTEGER_RE.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

export function parseUsageProviderFilterParam(
  raw: string | undefined
): UsageSourceProviderFilter | null | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (raw === 'all' || raw === 'claude-code' || raw === 'codex' || raw === 'local-models') {
    return raw;
  }
  return null;
}
