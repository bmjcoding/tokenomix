/**
 * csvExport.test.ts — Vitest tests for the RFC 4180 CSV serializer.
 *
 * Tests are split into two tiers:
 *
 *  1. Pure serialization tests (no DOM required):
 *     Tests call quoteField, serializeCsv, buildSessionsRows, and
 *     buildDailySeriesRows directly. These run in Node without any browser
 *     environment.
 *
 *  2. Download-trigger tests (require mocked browser globals):
 *     Tests call exportSessionsCsv / exportDailySeriesCsv and verify that the
 *     download path works. All browser APIs (document.createElement,
 *     document.body, URL.createObjectURL, URL.revokeObjectURL, Blob) are
 *     stubbed via vi.stubGlobal so no real DOM or jsdom environment is needed.
 *
 * RFC 4180 contract verified:
 *   - Correct header rows.
 *   - Correct row count (header + data rows).
 *   - CRLF line endings throughout.
 *   - Quoting of fields containing commas, double-quotes, CRs, and LFs.
 *   - Internal double-quotes are escaped by doubling.
 *   - Boolean values serialize as "true" / "false".
 */

import type { DailyBucket, SessionSummary } from '@tokenomix/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildDailySeriesRows,
  buildSessionsRows,
  DAILY_SERIES_HEADERS,
  escapeFormula,
  exportDailySeriesCsv,
  exportSessionsCsv,
  quoteField,
  SESSIONS_HEADERS,
  serializeCsv,
} from './csvExport.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SESSION_FIXTURES: SessionSummary[] = [
  {
    sessionId: 'abc123',
    project: '/home/user/project-a',
    projectName: 'project-a',
    // UTC noon — will not cross a date boundary in any common timezone
    firstTs: '2026-04-29T12:00:00.000Z',
    costUsd: 1.2345,
    inputTokens: 1000,
    outputTokens: 500,
    cacheCreationTokens: 200,
    cacheReadTokens: 100,
    events: 42,
    isSubagent: false,
    // 37 minutes and 30 seconds
    durationMs: 2_250_000,
    topTools: [],
    toolNamesCount: 0,
  },
  {
    sessionId: 'def456',
    // project contains a comma — must be quoted
    project: '/home/user/project, alpha',
    projectName: 'project, alpha',
    firstTs: null,
    costUsd: 0.0001,
    inputTokens: 10,
    outputTokens: 5,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    events: 1,
    isSubagent: true,
    // null — session evicted from sessionTimes map
    durationMs: null,
    topTools: [],
    toolNamesCount: 0,
  },
  {
    sessionId: 'ghi789',
    // project contains a double-quote — must be quoted and doubled
    project: '/home/user/say "hello"',
    projectName: 'say "hello"',
    firstTs: '2026-01-15T12:00:00.000Z',
    costUsd: 2.0,
    inputTokens: 2000,
    outputTokens: 1000,
    cacheCreationTokens: 400,
    cacheReadTokens: 300,
    events: 10,
    isSubagent: false,
    // 1 hour 5 minutes
    durationMs: 3_900_000,
    topTools: [],
    toolNamesCount: 0,
  },
];

const DAILY_FIXTURES: DailyBucket[] = [
  {
    date: '2026-01-01',
    costUsd: 0.5,
    inputTokens: 500,
    outputTokens: 250,
    cacheCreationTokens: 100,
    cacheReadTokens: 50,
  },
  {
    date: '2026-01-02',
    costUsd: 1.0,
    inputTokens: 1000,
    outputTokens: 500,
    cacheCreationTokens: 200,
    cacheReadTokens: 100,
  },
];

// ---------------------------------------------------------------------------
// Helper: parse CSV string into row arrays for assertion
// ---------------------------------------------------------------------------

/**
 * Parse an RFC 4180 CSV string (CRLF line endings) into an array of
 * string-cell rows. Handles quoted fields with embedded commas and doubled
 * double-quotes. Suitable for single-line-per-field CSV (our use case).
 */
function parseCsvRows(csv: string): string[][] {
  const lines = csv.split('\r\n');
  return lines.map((line) => {
    const cells: string[] = [];
    let i = 0;
    while (i < line.length) {
      if (line[i] === '"') {
        // Quoted field.
        let field = '';
        i++; // skip opening quote
        while (i < line.length) {
          if (line[i] === '"' && line[i + 1] === '"') {
            field += '"';
            i += 2;
          } else if (line[i] === '"') {
            i++; // skip closing quote
            break;
          } else {
            field += line[i];
            i++;
          }
        }
        cells.push(field);
        if (line[i] === ',') i++; // skip comma separator
      } else {
        // Unquoted field.
        const end = line.indexOf(',', i);
        if (end === -1) {
          cells.push(line.slice(i));
          break;
        }
        cells.push(line.slice(i, end));
        i = end + 1;
      }
    }
    return cells;
  });
}

// ---------------------------------------------------------------------------
// Pure serialization tests (no DOM required)
// ---------------------------------------------------------------------------

describe('escapeFormula', () => {
  it('prepends a single quote when the value starts with =', () => {
    expect(escapeFormula('=HYPERLINK("evil")')).toBe('\'=HYPERLINK("evil")');
  });

  it('prepends a single quote when the value starts with +', () => {
    expect(escapeFormula('+1234')).toBe("'+1234");
  });

  it('prepends a single quote when the value starts with -', () => {
    expect(escapeFormula('-1234')).toBe("'-1234");
  });

  it('prepends a single quote when the value starts with @', () => {
    expect(escapeFormula('@SUM(A1)')).toBe("'@SUM(A1)");
  });

  it('prepends a single quote when the value starts with a TAB character', () => {
    expect(escapeFormula('\tmalicious')).toBe("'\tmalicious");
  });

  it('leaves safe values unchanged', () => {
    expect(escapeFormula('safe-project')).toBe('safe-project');
    expect(escapeFormula('')).toBe('');
    expect(escapeFormula('/home/user/project')).toBe('/home/user/project');
    expect(escapeFormula('2026-01-01')).toBe('2026-01-01');
  });
});

describe('quoteField', () => {
  it('returns plain strings unchanged', () => {
    expect(quoteField('simple')).toBe('simple');
    expect(quoteField('2026-01-01')).toBe('2026-01-01');
    expect(quoteField('')).toBe('');
  });

  it('wraps fields containing a comma in double-quotes', () => {
    expect(quoteField('a,b')).toBe('"a,b"');
  });

  it('wraps fields containing a double-quote and doubles the quote', () => {
    expect(quoteField('say "hello"')).toBe('"say ""hello"""');
  });

  it('wraps fields containing a LF character', () => {
    expect(quoteField('line\none')).toBe('"line\none"');
  });

  it('wraps fields containing a CR character', () => {
    expect(quoteField('line\rone')).toBe('"line\rone"');
  });

  it('doubles all internal double-quotes', () => {
    expect(quoteField('"a","b"')).toBe('"""a"",""b"""');
  });
});

describe('serializeCsv', () => {
  it('joins rows with CRLF', () => {
    const rows = [
      ['A', 'B'],
      ['1', '2'],
    ] as const;
    expect(serializeCsv(rows)).toBe('A,B\r\n1,2');
  });

  it('converts numbers and booleans to strings', () => {
    const rows = [['label', 42, true]] as const;
    expect(serializeCsv(rows)).toBe('label,42,true');
  });

  it('returns a single row with no trailing CRLF', () => {
    const rows = [['only']] as const;
    expect(serializeCsv(rows)).toBe('only');
    expect(serializeCsv(rows).endsWith('\r\n')).toBe(false);
  });

  it('returns an empty string for an empty rows array', () => {
    expect(serializeCsv([])).toBe('');
  });
});

describe('buildSessionsRows', () => {
  it('first row is the sessions header', () => {
    const rows = buildSessionsRows([]);
    expect(rows[0]).toEqual(SESSIONS_HEADERS);
  });

  it('produces header + one row per session', () => {
    const rows = buildSessionsRows(SESSION_FIXTURES);
    // 1 header + 3 sessions
    expect(rows).toHaveLength(1 + SESSION_FIXTURES.length);
  });

  it('data row contains fields in the documented column order', () => {
    const rows = buildSessionsRows(SESSION_FIXTURES);
    const first = rows[1];
    expect(first).toBeDefined();
    // [date, project, projectName, sessionId, costUsd, inputTokens, outputTokens, cacheCreation, cacheRead, events, isSubagent, duration]
    // index 0 is the formatted date string
    expect(first?.[1]).toBe('/home/user/project-a');
    expect(first?.[2]).toBe('project-a');
    expect(first?.[3]).toBe('abc123');
    expect(first?.[4]).toBe(1.2345);
    expect(first?.[10]).toBe(false);
    // Duration cell: first fixture has durationMs: 2_250_000 (37m 30s)
    expect(typeof first?.[11]).toBe('string');
    expect(first?.[11]).not.toBe('');
  });

  it('date cell formats firstTs to MM-DD-YYYY', () => {
    const rows = buildSessionsRows(SESSION_FIXTURES);
    // first data row has firstTs '2026-04-29T12:00:00.000Z' (UTC noon — tz-safe)
    const dateCell = String(rows[1]?.[0]);
    expect(dateCell).toContain('-2026');
    expect(dateCell).toContain('04');
  });

  it('date cell is em-dash for null firstTs', () => {
    const rows = buildSessionsRows(SESSION_FIXTURES);
    // second data row has firstTs: null
    expect(rows[2]?.[0]).toBe('—');
  });

  it('each data row has 12 elements', () => {
    const rows = buildSessionsRows(SESSION_FIXTURES);
    // Skip header row (index 0)
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]).toHaveLength(12);
    }
  });

  it('produces header-only rows for an empty sessions array', () => {
    const rows = buildSessionsRows([]);
    expect(rows).toHaveLength(1);
  });
});

describe('buildDailySeriesRows', () => {
  it('first row is the daily series header', () => {
    const rows = buildDailySeriesRows([]);
    expect(rows[0]).toEqual(DAILY_SERIES_HEADERS);
  });

  it('produces header + one row per bucket', () => {
    const rows = buildDailySeriesRows(DAILY_FIXTURES);
    expect(rows).toHaveLength(1 + DAILY_FIXTURES.length);
  });

  it('data row contains fields in the documented column order', () => {
    const rows = buildDailySeriesRows(DAILY_FIXTURES);
    const first = rows[1];
    // [date, costUsd, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens]
    expect(first?.[0]).toBe('2026-01-01');
    expect(first?.[1]).toBe(0.5);
    expect(first?.[5]).toBe(50);
  });
});

describe('RFC 4180 output via serializeCsv + buildSessionsRows', () => {
  it('quotes a session project name that contains a comma', () => {
    const csv = serializeCsv(buildSessionsRows(SESSION_FIXTURES));
    expect(csv).toContain('"/home/user/project, alpha"');
  });

  it('quotes a session project name that contains a double-quote and doubles it', () => {
    const csv = serializeCsv(buildSessionsRows(SESSION_FIXTURES));
    expect(csv).toContain('"/home/user/say ""hello"""');
  });

  it('serializes boolean IsSubagent as "true" or "false"', () => {
    const csv = serializeCsv(buildSessionsRows(SESSION_FIXTURES));
    const rows = parseCsvRows(csv);
    expect(rows[1]?.[10]).toBe('false'); // first session isSubagent: false
    expect(rows[2]?.[10]).toBe('true'); // second session isSubagent: true
  });

  it('uses CRLF line endings throughout', () => {
    const csv = serializeCsv(buildSessionsRows(SESSION_FIXTURES));
    const crlfCount = (csv.match(/\r\n/g) ?? []).length;
    const bareLfCount = (csv.match(/(?<!\r)\n/g) ?? []).length;
    expect(crlfCount).toBeGreaterThan(0);
    expect(bareLfCount).toBe(0);
  });

  it('correct row count (header + 3 sessions)', () => {
    const csv = serializeCsv(buildSessionsRows(SESSION_FIXTURES));
    const rows = parseCsvRows(csv);
    expect(rows).toHaveLength(1 + SESSION_FIXTURES.length);
  });

  it('header row is correct', () => {
    const csv = serializeCsv(buildSessionsRows([]));
    const rows = parseCsvRows(csv);
    expect(rows[0]).toEqual([
      'Date',
      'Project',
      'ProjectName',
      'SessionId',
      'CostUSD',
      'InputTokens',
      'OutputTokens',
      'CacheCreation',
      'CacheRead',
      'Events',
      'IsSubagent',
      'Duration',
    ]);
  });

  it('Duration cell is formatted string for known durationMs', () => {
    const rows = parseCsvRows(serializeCsv(buildSessionsRows(SESSION_FIXTURES)));
    // first fixture: durationMs 2_250_000 — formatDurationNullable produces a non-em-dash string
    expect(rows[1]?.[11]).toBeDefined();
    expect(rows[1]?.[11]).not.toBe('—');
    // second fixture: durationMs null — should be em-dash
    expect(rows[2]?.[11]).toBe('—');
  });
});

describe('CSV injection prevention via quoteField + escapeFormula', () => {
  const makeSession = (project: string, projectName: string): SessionSummary => ({
    sessionId: 'test-id',
    project,
    projectName,
    firstTs: null,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    events: 0,
    isSubagent: false,
    durationMs: null,
    topTools: [],
    toolNamesCount: 0,
  });

  it('prefixes = formula trigger with a single quote in the Project column', () => {
    const csv = serializeCsv(buildSessionsRows([makeSession('=HYPERLINK("x")', 'evil')]));
    expect(csv).toContain("'=HYPERLINK");
  });

  it('prefixes + trigger in the ProjectName column', () => {
    const csv = serializeCsv(buildSessionsRows([makeSession('/safe/path', '+1')]));
    expect(csv).toContain("'+1");
  });

  it('prefixes - trigger', () => {
    const csv = serializeCsv(buildSessionsRows([makeSession('-bad', 'safe')]));
    expect(csv).toContain("'-bad");
  });

  it('prefixes @ trigger', () => {
    const csv = serializeCsv(buildSessionsRows([makeSession('@SUM(1)', 'safe')]));
    expect(csv).toContain("'@SUM(1)");
  });

  it('prefixes TAB trigger', () => {
    const csv = serializeCsv(buildSessionsRows([makeSession('\tevil', 'safe')]));
    expect(csv).toContain("'\t");
  });

  it('does not modify safe values', () => {
    const csv = serializeCsv(buildSessionsRows([makeSession('/home/user/project', 'project')]));
    expect(csv).toContain('/home/user/project');
    expect(csv).not.toContain("'");
  });
});

describe('RFC 4180 output via serializeCsv + buildDailySeriesRows', () => {
  it('produces correct header row for daily series', () => {
    const csv = serializeCsv(buildDailySeriesRows([]));
    const rows = parseCsvRows(csv);
    expect(rows[0]).toEqual([
      'Date',
      'CostUSD',
      'InputTokens',
      'OutputTokens',
      'CacheCreationTokens',
      'CacheReadTokens',
    ]);
  });

  it('correct row count (header + 2 buckets)', () => {
    const csv = serializeCsv(buildDailySeriesRows(DAILY_FIXTURES));
    const rows = parseCsvRows(csv);
    expect(rows).toHaveLength(1 + DAILY_FIXTURES.length);
  });

  it('serializes date and numeric fields correctly', () => {
    const csv = serializeCsv(buildDailySeriesRows(DAILY_FIXTURES));
    const rows = parseCsvRows(csv);
    expect(rows[1]).toEqual(['2026-01-01', '0.5', '500', '250', '100', '50']);
    expect(rows[2]).toEqual(['2026-01-02', '1', '1000', '500', '200', '100']);
  });

  it('uses CRLF line endings throughout', () => {
    const csv = serializeCsv(buildDailySeriesRows(DAILY_FIXTURES));
    const crlfCount = (csv.match(/\r\n/g) ?? []).length;
    const bareLfCount = (csv.match(/(?<!\r)\n/g) ?? []).length;
    expect(crlfCount).toBeGreaterThan(0);
    expect(bareLfCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Browser download trigger tests (all browser globals fully mocked)
// ---------------------------------------------------------------------------

/**
 * Minimal mock of an anchor element that records setAttribute calls and click.
 */
type LinkCapture = {
  href: string;
  download: string;
  clicked: boolean;
};

let lastLinkCapture: LinkCapture | null = null;
let lastBlobParts: string | null = null;

beforeEach(() => {
  lastLinkCapture = null;
  lastBlobParts = null;

  // Mock Blob — capture the concatenated content for inspection.
  vi.stubGlobal(
    'Blob',
    class MockBlob {
      constructor(parts: BlobPart[], _options?: BlobPropertyBag) {
        lastBlobParts = (parts as string[]).join('');
      }
    }
  );

  // Mock URL with createObjectURL + revokeObjectURL.
  vi.stubGlobal('URL', {
    createObjectURL: vi.fn(() => 'blob:mock-url'),
    revokeObjectURL: vi.fn(),
  });

  // Build a mock anchor element.
  const makeMockAnchor = (): HTMLAnchorElement => {
    const capture: LinkCapture = { href: '', download: '', clicked: false };
    const anchor = {
      setAttribute(name: string, value: string) {
        if (name === 'href') capture.href = value;
        if (name === 'download') capture.download = value;
      },
      click() {
        capture.clicked = true;
        lastLinkCapture = { ...capture };
      },
    };
    return anchor as unknown as HTMLAnchorElement;
  };

  // Mock document as a global.
  vi.stubGlobal('document', {
    createElement: vi.fn((tagName: string) => {
      if (tagName === 'a') return makeMockAnchor();
      throw new Error(`Unexpected createElement: ${tagName}`);
    }),
    body: {
      appendChild: vi.fn((node: unknown) => node),
      removeChild: vi.fn((node: unknown) => node),
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('exportSessionsCsv — download trigger', () => {
  it('triggers a click on the mock anchor element', () => {
    exportSessionsCsv(SESSION_FIXTURES);
    expect(lastLinkCapture?.clicked).toBe(true);
  });

  it('sets the download attribute to the default filename', () => {
    exportSessionsCsv(SESSION_FIXTURES);
    expect(lastLinkCapture?.download).toBe('sessions.csv');
  });

  it('sets a custom download filename when provided', () => {
    exportSessionsCsv(SESSION_FIXTURES, 'my-export.csv');
    expect(lastLinkCapture?.download).toBe('my-export.csv');
  });

  it('sets the href to the mocked blob URL', () => {
    exportSessionsCsv(SESSION_FIXTURES);
    expect(lastLinkCapture?.href).toBe('blob:mock-url');
  });

  it('passes a string blob containing the CSV header to Blob', () => {
    exportSessionsCsv(SESSION_FIXTURES);
    expect(lastBlobParts).toContain('Date,Project,ProjectName,SessionId,CostUSD');
  });

  it('passes a blob with correct row count', () => {
    exportSessionsCsv(SESSION_FIXTURES);
    const csv = lastBlobParts ?? '';
    // Split on CRLF — header + 3 data rows = 4 segments
    const rows = csv.split('\r\n');
    expect(rows).toHaveLength(1 + SESSION_FIXTURES.length);
  });

  it('handles an empty sessions array without throwing', () => {
    expect(() => exportSessionsCsv([])).not.toThrow();
  });
});

describe('exportDailySeriesCsv — download trigger', () => {
  it('triggers a click on the mock anchor element', () => {
    exportDailySeriesCsv(DAILY_FIXTURES);
    expect(lastLinkCapture?.clicked).toBe(true);
  });

  it('sets the download attribute to the default filename', () => {
    exportDailySeriesCsv(DAILY_FIXTURES);
    expect(lastLinkCapture?.download).toBe('daily-series.csv');
  });

  it('sets a custom download filename when provided', () => {
    exportDailySeriesCsv(DAILY_FIXTURES, 'chart-export.csv');
    expect(lastLinkCapture?.download).toBe('chart-export.csv');
  });

  it('sets the href to the mocked blob URL', () => {
    exportDailySeriesCsv(DAILY_FIXTURES);
    expect(lastLinkCapture?.href).toBe('blob:mock-url');
  });

  it('passes a string blob containing the CSV header to Blob', () => {
    exportDailySeriesCsv(DAILY_FIXTURES);
    expect(lastBlobParts).toContain('Date,CostUSD,InputTokens');
  });

  it('passes a blob with correct row count', () => {
    exportDailySeriesCsv(DAILY_FIXTURES);
    const csv = lastBlobParts ?? '';
    const rows = csv.split('\r\n');
    expect(rows).toHaveLength(1 + DAILY_FIXTURES.length);
  });

  it('handles an empty series array without throwing', () => {
    expect(() => exportDailySeriesCsv([])).not.toThrow();
  });
});
