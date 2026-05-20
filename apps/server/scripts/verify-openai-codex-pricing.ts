/**
 * Verify the static OpenAI/Codex pricing catalog against official OpenAI pages.
 *
 * This mirrors verify-anthropic-pricing.ts: the app uses a reviewed static
 * catalog for reproducible reports, while this script fails when the official
 * source pages no longer match the committed catalog.
 */

import {
  OPENAI_API_PRICING_CATALOG_METADATA,
  OPENAI_CODEX_MODEL_PRICES,
  openAiCodexFastModeMultiplierForModel,
} from '@tokenomix/shared';

const OPENAI_API_PRICING_URL = 'https://developers.openai.com/api/docs/pricing';
const OPENAI_GPT_5_5_MODEL_URL = 'https://developers.openai.com/api/docs/models/gpt-5.5';
const OPENAI_GPT_5_4_MODEL_URL = 'https://developers.openai.com/api/docs/models/gpt-5.4';
const CODEX_RATE_CARD_URL = 'https://help.openai.com/en/articles/20001106-codex-rate-card';
const CODEX_SPEED_URL = 'https://developers.openai.com/codex/speed';
const CREDITS_PER_USD = 25;

interface ApiExpectedRow {
  label: 'gpt-5.5' | 'gpt-5.4' | 'gpt-5.4-mini';
}

interface CodexRateCardExpectedRow {
  label: 'GPT-5.5' | 'GPT-5.4' | 'GPT-5.3-Codex' | 'GPT-5.2';
  modelKey: keyof typeof OPENAI_CODEX_MODEL_PRICES;
}

const API_EXPECTED_ROWS: ApiExpectedRow[] = [
  { label: 'gpt-5.5' },
  { label: 'gpt-5.4' },
  { label: 'gpt-5.4-mini' },
];

const CODEX_RATE_CARD_EXPECTED_ROWS: CodexRateCardExpectedRow[] = [
  { label: 'GPT-5.5', modelKey: 'gpt-5.5' },
  { label: 'GPT-5.4', modelKey: 'gpt-5.4' },
  { label: 'GPT-5.3-Codex', modelKey: 'gpt-5.3-codex' },
  { label: 'GPT-5.2', modelKey: 'gpt-5.2' },
];

function compact(s: string): string {
  return s.replace(/\s+/g, '').toLowerCase();
}

function visibleText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ');
}

async function fetchPage(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'User-Agent': 'Mozilla/5.0 (compatible; tokenomix-pricing-verifier/1.0; +https://localhost)',
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }
  return compact(visibleText(await response.text()));
}

function usdVariants(value: number): string[] {
  return [
    `$${value.toString()}`,
    `$${value.toFixed(0)}`,
    `$${value.toFixed(1)}`,
    `$${value.toFixed(2)}`,
    `$${value.toFixed(3)}`,
  ].filter((entry, index, all) => all.indexOf(entry) === index);
}

function creditVariants(value: number): string[] {
  return [
    `${value.toString()}credits`,
    `${value.toFixed(0)}credits`,
    `${value.toFixed(1)}credits`,
    `${value.toFixed(2)}credits`,
    `${value.toFixed(3)}credits`,
  ].filter((entry, index, all) => all.indexOf(entry) === index);
}

function assertContains(haystack: string, needle: string, label: string): void {
  if (!haystack.includes(compact(needle))) {
    throw new Error(`OpenAI/Codex pricing verification failed for ${label}`);
  }
}

function assertOrderedRow(
  page: string,
  label: string,
  values: string[][],
  verificationLabel: string,
  windowSize = 220
): void {
  const rowLabel = compact(label);
  let idx = -1;
  while (true) {
    idx = page.indexOf(rowLabel, idx + 1);
    if (idx === -1) break;
    const window = page.slice(idx, idx + windowSize);
    let cursor = 0;
    let matched = true;
    for (const variants of values) {
      const matches = variants
        .map((variant) => compact(variant))
        .map((variant) => window.indexOf(variant, cursor))
        .filter((next) => next !== -1);
      if (matches.length === 0) {
        matched = false;
        break;
      }
      cursor = Math.min(...matches) + 1;
    }
    if (matched) return;
  }
  throw new Error(`OpenAI/Codex pricing verification failed for ${verificationLabel}`);
}

async function main(): Promise<void> {
  const [apiPricingPage, gpt55Page, gpt54Page, codexRateCardPage, codexSpeedPage] =
    await Promise.all([
      fetchPage(OPENAI_API_PRICING_URL),
      fetchPage(OPENAI_GPT_5_5_MODEL_URL),
      fetchPage(OPENAI_GPT_5_4_MODEL_URL),
      fetchPage(CODEX_RATE_CARD_URL),
      fetchPage(CODEX_SPEED_URL),
    ]);

  for (const expected of API_EXPECTED_ROWS) {
    const prices = OPENAI_CODEX_MODEL_PRICES[expected.label];
    if (!prices) throw new Error(`Missing local OpenAI price row ${expected.label}`);
    assertOrderedRow(
      apiPricingPage,
      expected.label,
      [usdVariants(prices.input), usdVariants(prices.cachedInput), usdVariants(prices.output)],
      `${expected.label} API standard pricing`
    );
  }

  for (const expected of CODEX_RATE_CARD_EXPECTED_ROWS) {
    const prices = OPENAI_CODEX_MODEL_PRICES[expected.modelKey];
    if (!prices) throw new Error(`Missing local Codex price row ${expected.modelKey}`);
    assertOrderedRow(
      codexRateCardPage,
      expected.label,
      [
        creditVariants(prices.input * CREDITS_PER_USD),
        creditVariants(prices.cachedInput * CREDITS_PER_USD),
        creditVariants(prices.output * CREDITS_PER_USD),
      ],
      `${expected.label} Codex credit pricing`
    );
  }

  assertOrderedRow(
    gpt55Page,
    'GPT-5.5',
    [usdVariants(5), usdVariants(0.5), usdVariants(30)],
    'GPT-5.5 model-page standard pricing',
    800
  );
  assertContains(
    gpt55Page,
    'prompts with >272K input tokens are priced at 2x input and 1.5x output',
    'GPT-5.5 long-context threshold'
  );
  assertContains(gpt55Page, 'Regional processing', 'GPT-5.5 regional uplift disclosure');

  assertOrderedRow(
    gpt54Page,
    'GPT-5.4',
    [usdVariants(2.5), usdVariants(0.25), usdVariants(15)],
    'GPT-5.4 model-page standard pricing',
    800
  );
  assertContains(
    gpt54Page,
    'prompts with >272K input tokens are priced at 2x input and 1.5x output',
    'GPT-5.4 long-context threshold'
  );
  assertContains(gpt54Page, 'Regional processing', 'GPT-5.4 regional uplift disclosure');

  assertContains(codexRateCardPage, 'token-based pricing', 'Codex token-based pricing section');
  assertContains(codexRateCardPage, '25 credits', 'Codex legacy code review row');
  assertContains(codexRateCardPage, 'research preview', 'Codex Spark research-preview note');
  assertContains(codexRateCardPage, 'workspace migration status', 'Codex legacy/new rate-card FAQ');

  assertContains(codexSpeedPage, 'Fast mode', 'Codex Fast mode section');
  assertContains(codexSpeedPage, 'GPT-5.5', 'Codex Fast mode GPT-5.5 support');
  assertContains(codexSpeedPage, 'GPT-5.4', 'Codex Fast mode GPT-5.4 support');
  assertContains(
    codexSpeedPage,
    `${openAiCodexFastModeMultiplierForModel('gpt-5.5') ?? 0}x the Standard rate for GPT-5.5`,
    'Codex GPT-5.5 Fast mode multiplier'
  );
  assertContains(
    codexSpeedPage,
    `${openAiCodexFastModeMultiplierForModel('gpt-5.4') ?? 0}x the Standard rate for GPT-5.4`,
    'Codex GPT-5.4 Fast mode multiplier'
  );
  assertContains(
    codexSpeedPage,
    'With an API key, Codex uses standard API pricing instead',
    'Codex API-key standard-pricing note'
  );

  console.log(
    `OpenAI/Codex pricing verified against ${OPENAI_API_PRICING_CATALOG_METADATA.sourceUrl} (${API_EXPECTED_ROWS.length} API rows, ${CODEX_RATE_CARD_EXPECTED_ROWS.length} Codex rate-card rows).`
  );
}

await main();
