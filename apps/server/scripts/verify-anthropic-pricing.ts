/**
 * Verify the static pricing catalog against Anthropic's official pricing page.
 *
 * This intentionally verifies rather than live-mutating application pricing.
 * Mission-critical reporting needs a reviewed, versioned catalog; fetching a
 * web page at request time would make historical reports non-reproducible and
 * brittle to docs layout changes.
 */

import { MODEL_PRICES, PRICING_CATALOG_METADATA } from '@tokenomix/shared';

interface ExpectedRow {
  label: string;
  family: keyof typeof MODEL_PRICES;
}

const EXPECTED_ROWS: ExpectedRow[] = [
  { label: 'Claude Opus 4.7', family: 'opus' },
  { label: 'Claude Opus 4.6', family: 'opus' },
  { label: 'Claude Opus 4.5', family: 'opus' },
  { label: 'Claude Opus 4.1', family: 'opus_legacy' },
  { label: 'Claude Opus 4', family: 'opus_legacy' },
  { label: 'Claude Sonnet 4.6', family: 'sonnet' },
  { label: 'Claude Sonnet 4.5', family: 'sonnet' },
  { label: 'Claude Sonnet 4', family: 'sonnet' },
  { label: 'Claude Sonnet 3.7', family: 'sonnet' },
  { label: 'Claude Haiku 4.5', family: 'haiku' },
  { label: 'Claude Haiku 3.5', family: 'haiku_3_5' },
  { label: 'Claude Opus 3', family: 'opus_legacy' },
  { label: 'Claude Haiku 3', family: 'haiku_3' },
];

function compact(s: string): string {
  return s.replace(/\s+/g, '');
}

function visibleText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]*>/g, '');
}

function money(value: number): string {
  if (value > 0 && value < 1) return `$${value.toFixed(2)}/MTok`;
  return `$${Number.isInteger(value) ? value.toFixed(0) : value.toString()}/MTok`;
}

function moneyVariants(value: number): string[] {
  return [
    money(value),
    `$${value.toString()}/MTok`,
    `$${value.toFixed(2)}/MTok`,
    `$${value.toFixed(3)}/MTok`,
  ].filter((entry, index, all) => all.indexOf(entry) === index);
}

function assertContains(haystack: string, needle: string, label: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(`Anthropic pricing verification failed for ${label}`);
  }
}

function assertPricingRow(
  page: string,
  label: string,
  prices: Array<string[]>,
  verificationLabel: string
): void {
  const rowLabel = compact(label);
  let idx = -1;
  while (true) {
    idx = page.indexOf(rowLabel, idx + 1);
    if (idx === -1) break;
    const window = page.slice(idx, idx + 350);
    let cursor = 0;
    let matched = true;
    for (const variants of prices) {
      const nextMatches = variants
        .map((price) => window.indexOf(price, cursor))
        .filter((next) => next !== -1);
      if (nextMatches.length === 0) {
        matched = false;
        break;
      }
      const next = Math.min(...nextMatches);
      cursor = next + 1;
    }
    if (matched) return;
  }
  throw new Error(`Anthropic pricing verification failed for ${verificationLabel}`);
}

async function main(): Promise<void> {
  const response = await fetch(PRICING_CATALOG_METADATA.sourceUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${PRICING_CATALOG_METADATA.sourceUrl}: ${response.status}`);
  }

  const page = compact(visibleText(await response.text()));

  for (const expected of EXPECTED_ROWS) {
    const prices = MODEL_PRICES[expected.family];
    if (!prices) throw new Error(`Missing local price family ${expected.family}`);
    assertPricingRow(
      page,
      expected.label,
      [
        moneyVariants(prices.input),
        moneyVariants(prices.cache_creation_5m),
        moneyVariants(prices.cache_creation_1h),
        moneyVariants(prices.cache_read),
        moneyVariants(prices.output),
      ],
      expected.label
    );
  }

  assertContains(page, compact('Cache read (hit)0.1x base input price'), 'cache read multiplier');
  assertContains(page, compact('$10 per 1,000 searches'), 'web search unit price');
  assertContains(page, compact('The bash tool adds 245 input tokens'), 'Bash tool token overhead');
  assertContains(page, compact('US-only inference'), 'data residency multiplier section');
  assertContains(page, compact('Fast mode pricing'), 'fast mode multiplier section');
  assertContains(page, compact('Batch API'), 'batch discount section');

  console.log(
    `Anthropic pricing verified against ${PRICING_CATALOG_METADATA.sourceUrl} (${EXPECTED_ROWS.length} model rows).`
  );
}

await main();
