const POSITIVE_INTEGER_RE = /^[1-9]\d*$/;

export function parsePositiveIntegerParam(raw: string | undefined): number | null | undefined {
  if (raw === undefined) return undefined;
  if (!POSITIVE_INTEGER_RE.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}
