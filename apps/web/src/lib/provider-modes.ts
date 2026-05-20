import type { UsageSourceProviderFilter } from '@tokenomix/shared';

export type ProviderMode = UsageSourceProviderFilter;

export const PROVIDER_MODE_OPTIONS: ReadonlyArray<{ value: ProviderMode; label: string }> = [
  { value: 'all', label: 'All providers' },
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'codex', label: 'OpenAI Codex' },
  { value: 'local-models', label: 'Local Models' },
] as const;

export function providerModeLabel(value: ProviderMode | undefined): string {
  return PROVIDER_MODE_OPTIONS.find((option) => option.value === value)?.label ?? 'All providers';
}

export function providerModeQuery(value: ProviderMode): UsageSourceProviderFilter | undefined {
  return value === 'all' ? undefined : value;
}

export function withProviderMode<T extends Record<string, string | number>>(
  base: T,
  value: ProviderMode
): T | (T & { provider: UsageSourceProviderFilter }) {
  const provider = providerModeQuery(value);
  return provider ? { ...base, provider } : base;
}
