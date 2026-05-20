/**
 * Local provider-backed chat route for Optimization Opportunities.
 *
 * The server treats provider CLIs as opaque local executables. Gateway URLs,
 * credentials, and provider account settings remain in those CLIs and are never
 * read or exposed by tokenomix.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants as fsConstants } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { createInterface } from 'node:readline';
import type {
  MetricSummary,
  RecommendationChatMessage,
  RecommendationChatRequest,
  RecommendationChatResponse,
  RecommendationChatStatus,
  SessionDetail,
  SessionSummary,
  SessionTurnRow,
  UsageSourceProvider,
  UsageSourceProviderFilter,
} from '@tokenomix/shared';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { serverEnv } from '../env.js';
import type { IndexStore } from '../index-store.js';
import { logEvent } from '../logger.js';
import { parseUsageProviderFilterParam } from './query-params.js';

const MAX_MESSAGE_CHARS = 2_000;
const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_CHARS = 1_000;
const MAX_STDOUT_CHARS = 64_000;
const MAX_STDERR_CHARS = 8_000;
const MAX_IDENTIFIER_TERMS = 8;
const MAX_RETRIEVED_SESSIONS = 3;
const MAX_RETRIEVED_PROJECTS = 3;
const MAX_CONTEXT_SESSIONS = 5;
const MAX_CONTEXT_TURNS = 5;
const MAX_CONTEXT_TOOLS = 8;

type ChatProvider = 'claude-code' | 'codex';

export interface ChatRunResult {
  answer: string;
  durationMs: number | null;
  costUsd: number | null;
  sessionId: string | null;
  warning: string | null;
}

export type ChatStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; result: ChatRunResult };

export interface RecommendationChatRunner {
  readonly preservesContext?: boolean;
  status(): Promise<RecommendationChatStatus>;
  ask(prompt: string): Promise<ChatRunResult>;
  stream(prompt: string, signal?: AbortSignal): AsyncIterable<ChatStreamEvent>;
}

export type ClaudeRunResult = ChatRunResult;
export type ClaudeStreamEvent = ChatStreamEvent;
export type ClaudeRecommendationRunner = RecommendationChatRunner;

function basename(pathLike: string | undefined): string {
  if (!pathLike) return 'current project';
  const trimmed = pathLike.trim().replace(/[\\/]+$/, '');
  if (!trimmed) return 'current project';
  return nodePath.basename(trimmed) || 'current project';
}

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

function trimText(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`;
}

function defaultProviderFilter(
  provider: UsageSourceProviderFilter | undefined
): UsageSourceProviderFilter {
  return provider ?? 'all';
}

function metricsProviderFilter(
  provider: UsageSourceProviderFilter
): UsageSourceProvider | undefined {
  return provider === 'all' ? undefined : provider;
}

function chatProviderFor(provider: UsageSourceProviderFilter): ChatProvider | null {
  if (provider === 'local-models') return null;
  return provider === 'codex' ? 'codex' : 'claude-code';
}

function providerRuntimeLabel(provider: ChatProvider): string {
  return provider === 'codex' ? 'OpenAI Codex' : 'Claude Code';
}

function rowMatchesProvider(
  row: { sourceProvider?: UsageSourceProvider },
  provider?: UsageSourceProvider
): boolean {
  if (provider === undefined) return true;
  return (row.sourceProvider ?? 'claude-code') === provider;
}

function providerQuery(
  provider?: UsageSourceProvider
): { provider: UsageSourceProvider } | Record<string, never> {
  return provider === undefined ? {} : { provider };
}

function sourceBoundaryForProvider(provider: UsageSourceProviderFilter): string {
  if (provider === 'claude-code') {
    return 'Indexed Claude Code usage under ~/.claude/projects only; no arbitrary filesystem reads and no full transcript text.';
  }
  if (provider === 'codex') {
    return 'Indexed OpenAI Codex usage under ~/.codex/sessions and ~/.codex/archived_sessions only; no arbitrary filesystem reads and no full transcript text.';
  }
  if (provider === 'local-models') {
    return 'Indexed local-model telemetry under ~/.tokenomix/local-models only; chat is disabled for local-model-only mode.';
  }
  return 'Indexed Claude Code, OpenAI Codex, and local-model telemetry from configured Tokenomix usage sources only; no arbitrary filesystem reads and no full transcript text.';
}

function sanitizeHistory(value: unknown): RecommendationChatMessage[] {
  if (!Array.isArray(value)) return [];
  const messages: RecommendationChatMessage[] = [];
  for (const raw of value.slice(-MAX_HISTORY_MESSAGES)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const role = entry.role;
    const content = entry.content;
    if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string') continue;
    const trimmed = content.trim();
    if (!trimmed) continue;
    messages.push({ role, content: trimText(trimmed, MAX_HISTORY_CHARS) });
  }
  return messages;
}

function validateRequest(raw: unknown): RecommendationChatRequest | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const body = raw as Record<string, unknown>;
  if (typeof body.message !== 'string') return null;
  const message = body.message.trim();
  if (!message || message.length > MAX_MESSAGE_CHARS) return null;
  const provider =
    typeof body.provider === 'string'
      ? parseUsageProviderFilterParam(body.provider)
      : body.provider === undefined
        ? undefined
        : null;
  if (provider === null) return null;
  return {
    message,
    history: sanitizeHistory(body.history),
    ...(provider !== undefined && { provider }),
  };
}

function buildChatContext(
  summary: MetricSummary,
  provider: UsageSourceProviderFilter = 'all'
): unknown {
  return {
    sourceProvider: provider,
    window: 'absolute last 30 local calendar days unless noted otherwise',
    costUsd30d: roundCurrency(summary.costUsd30d),
    localEquivalentCosts30d: {
      claudeUsd: roundCurrency(summary.localEquivalentClaudeCostUsd30d ?? 0),
      openAiCodexUsd: roundCurrency(summary.localEquivalentCodexCostUsd30d ?? 0),
    },
    listedImpactUsd30d: roundCurrency(
      summary.optimizationOpportunities.reduce((sum, opportunity) => {
        return sum + opportunity.impactUsd30d;
      }, 0)
    ),
    costComponents30d: {
      inputCostUsd: roundCurrency(summary.costComponents30d.inputCostUsd),
      outputCostUsd: roundCurrency(summary.costComponents30d.outputCostUsd),
      cacheCreationCostUsd: roundCurrency(summary.costComponents30d.cacheCreationCostUsd),
      cacheReadCostUsd: roundCurrency(summary.costComponents30d.cacheReadCostUsd),
      webSearchCostUsd: roundCurrency(summary.costComponents30d.webSearchCostUsd),
    },
    diagnostics: {
      turnCostTop1PctShare30d: summary.turnCostTop1PctShare30d,
      turnCostTop5PctShare30d: summary.turnCostTop5PctShare30d,
      mainSessionCostUsd30d: roundCurrency(summary.mainSessionCostUsd30d),
      subagentCostUsd30d: roundCurrency(summary.subagentCostUsd30d),
      agentToolCalls30d: summary.agentToolCalls30d,
      opusToSonnetSavings30d: roundCurrency(summary.opusToSonnetSavings30d),
    },
    opportunities: summary.optimizationOpportunities.map((opportunity, index) => ({
      rank: index + 1,
      id: opportunity.id,
      area: opportunity.category,
      title: opportunity.title,
      recommendation: opportunity.recommendation,
      evidence: opportunity.evidence,
      impactUsd30d: roundCurrency(opportunity.impactUsd30d),
      ruleScore: opportunity.confidence,
      project: opportunity.project ? basename(opportunity.project) : null,
    })),
    topProjects30d: summary.byProject30d.slice(0, 5).map((project) => ({
      project: basename(project.project),
      costUsd: roundCurrency(project.costUsd),
      events: project.events,
    })),
    topModels: summary.byModel.slice(0, 5).map((model) => ({
      modelFamily: model.modelFamily,
      costUsd: roundCurrency(model.costUsd),
      events: model.events,
    })),
    pricingAudit: {
      provider: summary.pricingAudit.provider,
      costBasis: summary.pricingAudit.catalog.costBasis,
      catalogVersion: summary.pricingAudit.catalog.catalogVersion,
      fallbackPricedRows: summary.pricingAudit.fallbackPricedRows,
      internalGatewayRatedRows: summary.pricingAudit.internalGatewayRatedRows,
      internalGatewayUnratedRows: summary.pricingAudit.internalGatewayUnratedRows,
      warnings: summary.pricingAudit.warnings,
    },
    guardrails: [
      'Impact estimates are non-additive experiment candidates, not guaranteed savings.',
      'Answer only from this JSON context. Say when the context is insufficient.',
      'Do not expose or infer gateway URLs, auth tokens, AWS account IDs, or enterprise settings.',
      'Do not recommend changing model routing without matched quality trials.',
    ],
  };
}

function extractIdentifierTerms(question: string): string[] {
  const terms = new Set<string>();
  for (const match of question.matchAll(/[A-Za-z0-9][A-Za-z0-9_.:@-]{5,199}/g)) {
    const value = match[0].toLowerCase();
    if (!/[0-9_-]/.test(value)) continue;
    terms.add(value);
    if (terms.size >= MAX_IDENTIFIER_TERMS) break;
  }
  return [...terms];
}

function compactToolRecord(record: Record<string, number> | undefined): Record<string, number> {
  if (!record) return {};
  return Object.fromEntries(
    Object.entries(record)
      .filter(([, count]) => count > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_CONTEXT_TOOLS)
  );
}

function compactSessionSummary(session: SessionSummary): unknown {
  return {
    sessionId: session.sessionId,
    sourceProvider: session.sourceProvider ?? 'claude-code',
    project: session.projectName || basename(session.project),
    costUsd: roundCurrency(session.costUsd),
    events: session.events,
    inputTokens: session.inputTokens,
    outputTokens: session.outputTokens,
    cacheCreationTokens: session.cacheCreationTokens,
    cacheReadTokens: session.cacheReadTokens,
    durationMs: session.durationMs,
    isSubagent: session.isSubagent,
    topTools: session.topTools.slice(0, 3),
  };
}

function compactTurn(
  turn: SessionTurnRow,
  rank: number,
  sourceProvider: UsageSourceProvider | undefined
): unknown {
  return {
    rank,
    timestamp: turn.timestamp,
    sourceProvider: sourceProvider ?? 'claude-code',
    modelFamily: turn.modelFamily,
    modelId: turn.modelId,
    costUsd: roundCurrency(turn.costUsd),
    inputTokens: turn.inputTokens,
    outputTokens: turn.outputTokens,
    cacheReadTokens: turn.cacheReadTokens,
    durationMs: turn.durationMs,
    localRuntime: turn.localRuntime,
    tokensPerSecond: turn.tokensPerSecond,
    timeToFirstTokenMs: turn.timeToFirstTokenMs,
    equivalentClaudeCostUsd:
      turn.equivalentClaudeCostUsd === undefined
        ? undefined
        : roundCurrency(turn.equivalentClaudeCostUsd),
    equivalentOpenAiCodexCostUsd:
      turn.equivalentCodexCostUsd === undefined
        ? undefined
        : roundCurrency(turn.equivalentCodexCostUsd),
    toolUses: compactToolRecord(turn.toolUses),
    toolErrors: compactToolRecord(turn.toolErrors),
  };
}

function sessionDetailDurationMs(detail: SessionDetail): number | null {
  if (!detail.firstTs || !detail.lastTs) return null;
  const first = new Date(detail.firstTs).getTime();
  const last = new Date(detail.lastTs).getTime();
  if (!Number.isFinite(first) || !Number.isFinite(last)) return null;
  return Math.max(0, last - first);
}

function compactSessionDetail(detail: SessionDetail): unknown {
  const topTurns = detail.turns
    .slice()
    .sort((a, b) => b.costUsd - a.costUsd)
    .slice(0, MAX_CONTEXT_TURNS)
    .map((turn, index) => compactTurn(turn, index + 1, detail.sourceProvider));

  return {
    sessionId: detail.sessionId,
    sourceProvider: detail.sourceProvider ?? 'claude-code',
    project: detail.projectName || basename(detail.project),
    firstTs: detail.firstTs,
    lastTs: detail.lastTs,
    durationMs: sessionDetailDurationMs(detail),
    costUsd: roundCurrency(detail.costUsd),
    costBreakdown: {
      input: roundCurrency(detail.costBreakdown.input),
      output: roundCurrency(detail.costBreakdown.output),
      cacheCreate: roundCurrency(detail.costBreakdown.cacheCreate),
      cacheRead: roundCurrency(detail.costBreakdown.cacheRead),
      webSearch: roundCurrency(detail.costBreakdown.webSearch),
    },
    inputTokens: detail.inputTokens,
    outputTokens: detail.outputTokens,
    cacheCreationTokens: detail.cacheCreationTokens,
    cacheReadTokens: detail.cacheReadTokens,
    webSearchRequests: detail.webSearchRequests,
    events: detail.events,
    isSubagent: detail.isSubagent,
    initialPrompt: detail.initialPrompt,
    initialPromptTruncated: detail.initialPromptTruncated,
    topTools: detail.byTool.slice(0, MAX_CONTEXT_TOOLS),
    topExpensiveTurns: topTurns,
  };
}

function findSessionIdsForQuestion(
  store: IndexStore,
  question: string,
  provider?: UsageSourceProvider
): string[] {
  const terms = extractIdentifierTerms(question);
  if (terms.length === 0) return [];

  const matches = new Set<string>();
  for (const row of store.rows.values()) {
    if (!rowMatchesProvider(row, provider)) continue;
    const sessionId = row.sessionId;
    const normalized = sessionId.toLowerCase();
    if (terms.some((term) => normalized.includes(term))) {
      matches.add(sessionId);
      if (matches.size >= MAX_RETRIEVED_SESSIONS) break;
    }
  }
  return [...matches];
}

function findProjectsForQuestion(summary: MetricSummary, question: string): string[] {
  const normalizedQuestion = question.toLowerCase();
  const projects = new Set<string>();
  for (const project of [...summary.byProject30d, ...summary.byProject]) {
    const name = basename(project.project).toLowerCase();
    if (name.length < 3) continue;
    if (
      normalizedQuestion.includes(name) ||
      normalizedQuestion.includes(project.project.toLowerCase())
    ) {
      projects.add(project.project);
      if (projects.size >= MAX_RETRIEVED_PROJECTS) break;
    }
  }
  return [...projects];
}

function shouldIncludeBroadSessionContext(question: string): boolean {
  return /\b(session|sessions|expensive|costly|spend|spending|cost|costs)\b/i.test(question);
}

function shouldIncludeTurnContext(question: string): boolean {
  return /\b(turn|turns|outlier|outliers|tool|tools|bash|cache|tokens?)\b/i.test(question);
}

function shouldIncludeOpportunityContext(question: string): boolean {
  return /\b(opportunit|recommend|routing|model|cache|subagent|workflow|tooling|project)\b/i.test(
    question
  );
}

function buildProjectContext(
  store: IndexStore,
  summary: MetricSummary,
  projectPath: string,
  provider?: UsageSourceProvider
): unknown {
  const projectName = basename(projectPath);
  const allTime = summary.byProject.find((project) => project.project === projectPath);
  const last30d = summary.byProject30d.find((project) => project.project === projectPath);
  const sessions = store
    .getSessions({ project: projectPath, ...providerQuery(provider) })
    .slice(0, MAX_CONTEXT_SESSIONS)
    .map(compactSessionSummary);

  return {
    project: projectName,
    costUsd: allTime ? roundCurrency(allTime.costUsd) : null,
    costUsd30d: last30d ? roundCurrency(last30d.costUsd) : null,
    events: allTime?.events ?? null,
    events30d: last30d?.events ?? null,
    topSessions: sessions,
    topExpensiveTurns: store
      .getTurns({ project: projectPath, ...providerQuery(provider) }, MAX_CONTEXT_TURNS)
      .map((turn, index) => ({
        rank: index + 1,
        sessionId: turn.sessionId,
        timestamp: turn.timestamp,
        modelFamily: turn.modelFamily,
        costUsd: roundCurrency(turn.costUsd),
        inputTokens: turn.inputTokens,
        outputTokens: turn.outputTokens,
        cacheReadTokens: turn.cacheReadTokens,
        durationMs: turn.durationMs,
      })),
  };
}

function buildRetrievedChatContext(args: {
  store: IndexStore;
  summary: MetricSummary;
  request: RecommendationChatRequest;
  includeBaseline: boolean;
  provider: UsageSourceProviderFilter;
}): unknown | null {
  const { store, summary, request, includeBaseline, provider } = args;
  const metricsProvider = metricsProviderFilter(provider);
  const sessionIds = findSessionIdsForQuestion(store, request.message, metricsProvider);
  const matchedSessions = sessionIds
    .map((sessionId) => store.getSessionDetail(sessionId))
    .filter((detail): detail is SessionDetail => detail !== null)
    .map(compactSessionDetail);
  const projectPaths = findProjectsForQuestion(summary, request.message);
  const matchedProjects = projectPaths.map((projectPath) =>
    buildProjectContext(store, summary, projectPath, metricsProvider)
  );

  const includeBroadSessions = includeBaseline || shouldIncludeBroadSessionContext(request.message);
  const includeTurns =
    includeBaseline || matchedSessions.length > 0 || shouldIncludeTurnContext(request.message);
  const includeOpportunities = includeBaseline || shouldIncludeOpportunityContext(request.message);

  if (
    !includeBaseline &&
    matchedSessions.length === 0 &&
    matchedProjects.length === 0 &&
    !includeBroadSessions &&
    !includeTurns &&
    !includeOpportunities
  ) {
    return null;
  }

  return {
    sourceBoundary: sourceBoundaryForProvider(provider),
    mode: includeBaseline ? 'baseline-plus-targeted-retrieval' : 'targeted-followup-retrieval',
    baseline: includeBaseline ? buildChatContext(summary, provider) : undefined,
    matchedSessions,
    matchedProjects,
    optimizationOpportunities: includeOpportunities
      ? summary.optimizationOpportunities.map((opportunity, index) => ({
          rank: index + 1,
          id: opportunity.id,
          area: opportunity.category,
          title: opportunity.title,
          recommendation: opportunity.recommendation,
          evidence: opportunity.evidence,
          impactUsd30d: roundCurrency(opportunity.impactUsd30d),
          ruleScore: opportunity.confidence,
          project: opportunity.project ? basename(opportunity.project) : null,
        }))
      : undefined,
    topExpensiveSessions: includeBroadSessions
      ? store
          .getSessions({ ...providerQuery(metricsProvider) })
          .slice(0, MAX_CONTEXT_SESSIONS)
          .map(compactSessionSummary)
      : undefined,
    topExpensiveTurns: includeTurns
      ? store
          .getTurns({ ...providerQuery(metricsProvider) }, MAX_CONTEXT_TURNS)
          .map((turn, index) => ({
            rank: index + 1,
            sessionId: turn.sessionId,
            sourceProvider: turn.sourceProvider ?? 'claude-code',
            project: basename(turn.project),
            timestamp: turn.timestamp,
            modelFamily: turn.modelFamily,
            modelId: turn.modelId,
            costUsd: roundCurrency(turn.costUsd),
            inputTokens: turn.inputTokens,
            outputTokens: turn.outputTokens,
            cacheReadTokens: turn.cacheReadTokens,
            durationMs: turn.durationMs,
            localRuntime: turn.localRuntime,
            tokensPerSecond: turn.tokensPerSecond,
            timeToFirstTokenMs: turn.timeToFirstTokenMs,
            equivalentClaudeCostUsd:
              turn.equivalentClaudeCostUsd === undefined
                ? undefined
                : roundCurrency(turn.equivalentClaudeCostUsd),
            equivalentOpenAiCodexCostUsd:
              turn.equivalentCodexCostUsd === undefined
                ? undefined
                : roundCurrency(turn.equivalentCodexCostUsd),
          }))
      : undefined,
  };
}

function buildPrompt(request: RecommendationChatRequest, retrievedContext: unknown): string {
  const history = (request.history ?? []).map((message) => ({
    role: message.role,
    content: message.content,
  }));
  return JSON.stringify(
    {
      task: 'Answer the user as a read-only Tokenomix cost-optimization analyst.',
      responseRules: [
        'Keep the answer concise and concrete.',
        'Ground every claim in the supplied retrieved context.',
        'Refer to opportunity ids or titles when relevant.',
        'Treat listed impact as non-additive and experimental.',
        'Do not ask to run tools, inspect files, or mutate code.',
      ],
      context: retrievedContext,
      conversationHistory: history,
      userQuestion: request.message,
    },
    null,
    2
  );
}

function buildFollowupPrompt(
  request: RecommendationChatRequest,
  retrievedContext: unknown | null
): string {
  return JSON.stringify(
    {
      task: 'Continue the same read-only Tokenomix cost-optimization chat session.',
      responseRules: [
        'Use the Tokenomix metrics context already supplied earlier in this analyst session.',
        'When supplemental retrieved context is present below, use it for this question.',
        'Keep the answer concise and concrete.',
        'Ground claims in the supplied metrics or retrieved context.',
        'Treat listed impact as non-additive and experimental.',
        'Do not ask to run tools, inspect files, or mutate code.',
      ],
      supplementalRetrievedContext: retrievedContext ?? undefined,
      userQuestion: request.message,
    },
    null,
    2
  );
}

function claudeSystemPrompt(): string {
  return [
    'You are a read-only analyst embedded in a local Tokenomix dashboard.',
    'You explain Optimization Opportunities from supplied JSON only.',
    'You do not use tools, inspect files, or make changes.',
    'You do not reveal or speculate about enterprise gateway/auth configuration.',
    'You distinguish observed cost facts from experiment hypotheses.',
  ].join(' ');
}

function groundedOpportunityIds(summary: MetricSummary, answer: string): string[] {
  const normalizedAnswer = answer.toLowerCase();
  return summary.optimizationOpportunities
    .filter((opportunity) => {
      return (
        normalizedAnswer.includes(opportunity.id.toLowerCase()) ||
        normalizedAnswer.includes(opportunity.title.toLowerCase())
      );
    })
    .map((opportunity) => opportunity.id);
}

/**
 * Shell metacharacters that must not appear in a command path. A value
 * containing any of these characters cannot be a legitimate executable name
 * or absolute path and is treated as a potential injection attempt.
 *
 * Space is intentionally included: spawn() with shell:false does not need
 * shell word-splitting, so spaces in the binary path would only be valid for
 * an absolute path (which should be quoted at the OS level, not here).
 * Callers that need an absolute path with spaces should set
 * TOKENOMIX_*_COMMAND to the quoted path — but that scenario is
 * explicitly unsupported by this validator; users should use a wrapper script.
 */
const SHELL_METACHAR_RE = /[\0\r\n\t ;<>&|$`'"\\*?~(){}[\]]/;

/**
 * Validate a candidate command string for use as the first argument to
 * spawn(). Returns true only when the value is safe to pass through:
 *
 *  - Not empty.
 *  - Contains no null bytes or non-printable ASCII characters.
 *  - Contains no shell metacharacters (see SHELL_METACHAR_RE).
 *  - Contains no path-traversal sequences (/../ or leading ../).
 *  - Is either a plain basename ("claude") or an absolute path
 *    ("/usr/local/bin/claude"). Relative paths beginning with "./" are
 *    also rejected because they depend on the working directory and are
 *    indistinguishable from a traversal attempt in many contexts.
 */
function validateCommandPath(value: string): boolean {
  if (!value) return false;

  // Null byte or non-printable ASCII (control chars 0x01-0x1f, 0x7f)
  // SHELL_METACHAR_RE already covers \x00, \r, \n, \t — this catches the rest.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control-char check
  if (/[\x01-\x09\x0b\x0c\x0e-\x1f\x7f]/.test(value)) return false;

  // Shell metacharacters
  if (SHELL_METACHAR_RE.test(value)) return false;

  // Path traversal: any segment that is ".." (works for both Unix and Windows paths)
  if (/(^|[/\\])\.\.([/\\]|$)/.test(value)) return false;

  // Reject relative paths starting with "./" or ".\" (working-dir-relative)
  if (/^\.[\\/]/.test(value)) return false;

  return true;
}

// Module-level cache: resolved and validated on first call, reused thereafter.
// `null` means the command was not found; `false` means it has not been resolved yet.
let cachedClaudeCommand: string | null | false = false;
let cachedCodexCommand: string | null | false = false;

async function executableExists(command: string): Promise<boolean> {
  try {
    await access(command, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the Claude executable path and validate it for safe use with
 * spawn(). The result is cached after the first successful resolution.
 *
 * Resolution order:
 *  1. TOKENOMIX_CLAUDE_COMMAND env var (if set and passes validation)
 *  2. ~/.local/bin/claude (if the file is accessible and executable)
 *  3. 'claude' (plain basename — relies on PATH resolution by the OS)
 *
 * Returns null if TOKENOMIX_CLAUDE_COMMAND is set but fails validation.
 * In that case the route should return 503 rather than attempting to spawn.
 */
async function resolveClaudeCommand(): Promise<string | null> {
  if (cachedClaudeCommand !== false) return cachedClaudeCommand;

  const configured = serverEnv().TOKENOMIX_CLAUDE_COMMAND?.trim();
  if (configured !== undefined && configured !== '') {
    if (!validateCommandPath(configured)) {
      logEvent('warn', 'claude_command_invalid_path', {
        reason:
          'TOKENOMIX_CLAUDE_COMMAND contains shell metacharacters, path traversal, or non-printable characters and has been rejected.',
        value: configured,
      });
      cachedClaudeCommand = null;
      return null;
    }
    // Optionally verify the absolute path is executable (skipped for plain basenames
    // because PATH lookup happens inside spawn() and we cannot race against it here).
    if (nodePath.isAbsolute(configured)) {
      try {
        accessSync(configured, fsConstants.X_OK);
      } catch {
        logEvent('warn', 'claude_command_not_executable', {
          reason: 'TOKENOMIX_CLAUDE_COMMAND path exists but is not executable by this process.',
          value: configured,
        });
        cachedClaudeCommand = null;
        return null;
      }
    }
    cachedClaudeCommand = configured;
    return configured;
  }

  const homeCandidate = nodePath.join(os.homedir(), '.local', 'bin', 'claude');
  if (await executableExists(homeCandidate)) {
    cachedClaudeCommand = homeCandidate;
    return homeCandidate;
  }

  cachedClaudeCommand = 'claude';
  return 'claude';
}

async function resolveCodexCommand(): Promise<string | null> {
  if (cachedCodexCommand !== false) return cachedCodexCommand;

  const configured = serverEnv().TOKENOMIX_CODEX_COMMAND?.trim();
  if (configured !== undefined && configured !== '') {
    if (!validateCommandPath(configured)) {
      logEvent('warn', 'codex_command_invalid_path', {
        reason:
          'TOKENOMIX_CODEX_COMMAND contains shell metacharacters, path traversal, or non-printable characters and has been rejected.',
        value: configured,
      });
      cachedCodexCommand = null;
      return null;
    }
    if (nodePath.isAbsolute(configured)) {
      try {
        accessSync(configured, fsConstants.X_OK);
      } catch {
        logEvent('warn', 'codex_command_not_executable', {
          reason: 'TOKENOMIX_CODEX_COMMAND path exists but is not executable by this process.',
          value: configured,
        });
        cachedCodexCommand = null;
        return null;
      }
    }
    cachedCodexCommand = configured;
    return configured;
  }

  const candidates = [
    nodePath.join('/Applications', 'Codex.app', 'Contents', 'Resources', 'codex'),
    nodePath.join(os.homedir(), '.local', 'bin', 'codex'),
    nodePath.join('/opt', 'homebrew', 'bin', 'codex'),
    nodePath.join('/usr', 'local', 'bin', 'codex'),
  ];
  for (const candidate of candidates) {
    if (await executableExists(candidate)) {
      cachedCodexCommand = candidate;
      return candidate;
    }
  }

  cachedCodexCommand = 'codex';
  return 'codex';
}

export function parseClaudeOutput(stdout: string): ClaudeRunResult {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return {
      answer: '',
      durationMs: null,
      costUsd: null,
      sessionId: null,
      warning: null,
    };
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      let lastAssistantText = '';
      let resultEvent: Record<string, unknown> | null = null;
      for (const entry of parsed) {
        if (typeof entry !== 'object' || entry === null) continue;
        const event = entry as Record<string, unknown>;
        if (event.type === 'assistant') {
          const message = event.message;
          if (typeof message !== 'object' || message === null) continue;
          const content = (message as Record<string, unknown>).content;
          if (!Array.isArray(content)) continue;
          const text = content
            .map((block) => {
              if (typeof block !== 'object' || block === null) return '';
              const typedBlock = block as Record<string, unknown>;
              return typedBlock.type === 'text' && typeof typedBlock.text === 'string'
                ? typedBlock.text
                : '';
            })
            .filter(Boolean)
            .join('\n');
          if (text) lastAssistantText = text;
        } else if (event.type === 'result') {
          resultEvent = event;
        }
      }
      const result = resultEvent?.result;
      const errors = resultEvent?.errors;
      const warning =
        resultEvent?.subtype === 'error_max_budget_usd'
          ? 'Claude Code reached the configured chat budget cap after producing this answer.'
          : Array.isArray(errors) && errors.every((error) => typeof error === 'string')
            ? errors.join(' ')
            : null;
      return {
        answer: typeof result === 'string' ? result : lastAssistantText || trimmed,
        durationMs: typeof resultEvent?.duration_ms === 'number' ? resultEvent.duration_ms : null,
        costUsd:
          typeof resultEvent?.total_cost_usd === 'number' ? resultEvent.total_cost_usd : null,
        sessionId: typeof resultEvent?.session_id === 'string' ? resultEvent.session_id : null,
        warning,
      };
    }

    const parsedRecord = parsed as Record<string, unknown>;
    const result = parsedRecord.result;
    const answer =
      typeof result === 'string'
        ? result
        : typeof parsedRecord.message === 'string'
          ? parsedRecord.message
          : trimmed;
    const cost =
      typeof parsedRecord.total_cost_usd === 'number'
        ? parsedRecord.total_cost_usd
        : typeof parsedRecord.cost_usd === 'number'
          ? parsedRecord.cost_usd
          : null;
    const duration =
      typeof parsedRecord.duration_ms === 'number'
        ? parsedRecord.duration_ms
        : typeof parsedRecord.durationMs === 'number'
          ? parsedRecord.durationMs
          : null;
    const sessionId = typeof parsedRecord.session_id === 'string' ? parsedRecord.session_id : null;
    return { answer, durationMs: duration, costUsd: cost, sessionId, warning: null };
  } catch {
    return {
      answer: trimmed,
      durationMs: null,
      costUsd: null,
      sessionId: null,
      warning: null,
    };
  }
}

function warningForResultEvent(event: Record<string, unknown>): string | null {
  const errors = event.errors;
  if (event.subtype === 'error_max_budget_usd') {
    return 'Claude Code reached the configured chat budget cap after producing this answer.';
  }
  return Array.isArray(errors) && errors.every((error) => typeof error === 'string')
    ? errors.join(' ')
    : null;
}

export function parseClaudeStreamLine(line: string): ClaudeStreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const event = parsed as Record<string, unknown>;

  if (event.type === 'stream_event') {
    const streamEvent = event.event;
    if (typeof streamEvent !== 'object' || streamEvent === null) return null;
    const typedStreamEvent = streamEvent as Record<string, unknown>;
    if (typedStreamEvent.type !== 'content_block_delta') return null;
    const delta = typedStreamEvent.delta;
    if (typeof delta !== 'object' || delta === null) return null;
    const typedDelta = delta as Record<string, unknown>;
    if (typedDelta.type === 'text_delta' && typeof typedDelta.text === 'string') {
      return { type: 'delta', text: typedDelta.text };
    }
    return null;
  }

  if (event.type === 'result') {
    return {
      type: 'done',
      result: {
        answer: typeof event.result === 'string' ? event.result : '',
        durationMs: typeof event.duration_ms === 'number' ? event.duration_ms : null,
        costUsd: typeof event.total_cost_usd === 'number' ? event.total_cost_usd : null,
        sessionId: typeof event.session_id === 'string' ? event.session_id : null,
        warning: warningForResultEvent(event),
      },
    };
  }

  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function numberField(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

function stringField(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

function textFromCodexContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      const typedBlock = asRecord(block);
      if (!typedBlock) return '';
      const type = typedBlock.type;
      if (
        (type === 'output_text' || type === 'text' || type === 'input_text') &&
        typeof typedBlock.text === 'string'
      ) {
        return typedBlock.text;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function codexPayload(event: Record<string, unknown>): Record<string, unknown> {
  return asRecord(event.payload) ?? event;
}

function extractCodexSessionId(event: Record<string, unknown>): string | null {
  const direct = stringField(event, ['session_id', 'sessionId', 'thread_id', 'threadId']);
  if (direct) return direct;
  const payload = codexPayload(event);
  return stringField(payload, ['session_id', 'sessionId', 'thread_id', 'threadId', 'id']);
}

function extractCodexAnswer(event: Record<string, unknown>): string | null {
  const payload = codexPayload(event);
  const payloadType = payload.type;

  if (payloadType === 'agent_message') {
    return stringField(payload, ['message', 'text', 'last_agent_message']);
  }

  if (payloadType === 'task_complete') {
    return stringField(payload, ['last_agent_message', 'message', 'result']);
  }

  if (payloadType === 'message' && payload.role === 'assistant') {
    const text = textFromCodexContent(payload.content);
    return text || null;
  }

  if (event.type === 'result' || event.type === 'turn.completed' || event.type === 'completed') {
    return stringField(event, ['result', 'answer', 'message', 'last_agent_message']);
  }

  if (event.type === 'message' && event.role === 'assistant') {
    const text = textFromCodexContent(event.content);
    return text || null;
  }

  return null;
}

function extractCodexDelta(event: Record<string, unknown>): string | null {
  const payload = codexPayload(event);
  const type = typeof payload.type === 'string' ? payload.type : String(event.type ?? '');
  if (!type.toLowerCase().includes('delta')) return null;
  return (
    stringField(payload, ['delta', 'text', 'message']) ?? stringField(event, ['delta', 'text'])
  );
}

function extractCodexDurationMs(event: Record<string, unknown>): number | null {
  const payload = codexPayload(event);
  return (
    numberField(payload, ['duration_ms', 'durationMs']) ??
    numberField(event, ['duration_ms', 'durationMs'])
  );
}

function extractCodexCostUsd(event: Record<string, unknown>): number | null {
  const payload = codexPayload(event);
  return (
    numberField(payload, ['total_cost_usd', 'cost_usd', 'costUsd']) ??
    numberField(event, ['total_cost_usd', 'cost_usd', 'costUsd'])
  );
}

function extractCodexWarning(event: Record<string, unknown>): string | null {
  const payload = codexPayload(event);
  const type = stringField(payload, ['type']) ?? stringField(event, ['type']);
  if (type === 'error' || type === 'turn.failed' || type === 'task_failed') {
    return stringField(payload, ['message', 'error']) ?? stringField(event, ['message', 'error']);
  }
  return null;
}

function parseJsonEventLines(stdout: string): Record<string, unknown>[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) return parsed.map(asRecord).filter((entry) => entry !== null);
    const record = asRecord(parsed);
    if (record) return [record];
  } catch {
    // Fall back to JSONL parsing below.
  }

  const events: Record<string, unknown>[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const candidate = line.trim();
    if (!candidate) continue;
    try {
      const record = asRecord(JSON.parse(candidate) as unknown);
      if (record) events.push(record);
    } catch {
      // Codex may emit non-JSON diagnostics to stdout on old versions; ignore them.
    }
  }
  return events;
}

export function parseCodexOutput(stdout: string): ChatRunResult {
  const events = parseJsonEventLines(stdout);
  let answer = '';
  let durationMs: number | null = null;
  let costUsd: number | null = null;
  let sessionId: string | null = null;
  let warning: string | null = null;

  for (const event of events) {
    sessionId = extractCodexSessionId(event) ?? sessionId;
    answer = extractCodexAnswer(event) ?? answer;
    durationMs = extractCodexDurationMs(event) ?? durationMs;
    costUsd = extractCodexCostUsd(event) ?? costUsd;
    warning = extractCodexWarning(event) ?? warning;
  }

  return {
    answer: answer || stdout.trim(),
    durationMs,
    costUsd,
    sessionId,
    warning,
  };
}

export function parseCodexStreamLine(line: string): ChatStreamEvent | null {
  const event = asRecord(parseJsonEventLines(line)[0]);
  if (!event) return null;

  const delta = extractCodexDelta(event);
  if (delta) return { type: 'delta', text: delta };

  const payload = codexPayload(event);
  const payloadType = payload.type;
  const eventType = event.type;
  const isDone =
    payloadType === 'task_complete' ||
    eventType === 'result' ||
    eventType === 'turn.completed' ||
    eventType === 'completed';
  if (!isDone) return null;

  const parsed = parseCodexOutput(line);
  return { type: 'done', result: parsed };
}

function normalizeClaudeEffort(value: string | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === 'low' ||
    normalized === 'medium' ||
    normalized === 'high' ||
    normalized === 'xhigh' ||
    normalized === 'max'
  ) {
    return normalized;
  }
  return null;
}

export class LocalClaudeRecommendationRunner implements ClaudeRecommendationRunner {
  readonly preservesContext = true;

  private readonly timeoutMs: number;
  private readonly maxBudgetUsd: string;
  private readonly model: string;
  private readonly sessionId: string;
  private readonly effort: string | null;
  private readonly bareMode: boolean;
  private hasStarted = false;

  constructor(args: { timeoutMs?: number; maxBudgetUsd?: string } = {}) {
    const env = serverEnv();
    this.timeoutMs = args.timeoutMs ?? env.TOKENOMIX_CLAUDE_CHAT_TIMEOUT_MS;
    this.maxBudgetUsd = args.maxBudgetUsd ?? env.TOKENOMIX_CLAUDE_CHAT_MAX_BUDGET_USD;
    this.model = env.TOKENOMIX_CLAUDE_CHAT_MODEL;
    this.sessionId = randomUUID();
    this.effort = normalizeClaudeEffort(env.TOKENOMIX_CLAUDE_CHAT_EFFORT);
    this.bareMode = env.TOKENOMIX_CLAUDE_CHAT_BARE;
  }

  async status(): Promise<RecommendationChatStatus> {
    const command = await resolveClaudeCommand();
    if (!command) {
      return {
        available: false,
        configured: false,
        providerDetails: 'managed_by_claude_code',
        version: null,
        message: 'Claude Code executable was not found in this server process.',
      };
    }

    try {
      const version = await runCommand(command, ['--version'], 5_000);
      if (version.code !== 0) throw new Error('claude_version_failed');
      return {
        available: true,
        configured: true,
        providerDetails: 'managed_by_claude_code',
        version: version.stdout.trim() || null,
        message: 'Claude Code is available. Provider configuration is managed by Claude Code.',
      };
    } catch {
      return {
        available: false,
        configured: false,
        providerDetails: 'managed_by_claude_code',
        version: null,
        message: 'Claude Code is installed but could not be executed by this server process.',
      };
    }
  }

  async ask(prompt: string): Promise<ClaudeRunResult> {
    const command = await resolveClaudeCommand();
    if (!command) throw new Error('claude_unavailable');

    const args = this.buildArgs(prompt, 'json');
    const result = await runCommand(command, args, this.timeoutMs);
    const parsed = parseClaudeOutput(result.stdout);
    if (result.code !== 0 && !parsed.answer) {
      throw new Error(`claude_exit_${result.code}`);
    }
    this.hasStarted = true;
    return parsed;
  }

  async *stream(prompt: string, signal?: AbortSignal): AsyncIterable<ClaudeStreamEvent> {
    const command = await resolveClaudeCommand();
    if (!command) throw new Error('claude_unavailable');

    const args = this.buildArgs(prompt, 'stream-json');
    let sawResult = false;
    let streamedAnswer = '';
    let finalResult: ClaudeRunResult | null = null;

    for await (const line of streamCommand(command, args, this.timeoutMs, signal)) {
      const event = parseClaudeStreamLine(line);
      if (!event) continue;
      if (event.type === 'delta') {
        streamedAnswer += event.text;
        yield event;
        continue;
      }

      sawResult = true;
      finalResult = {
        ...event.result,
        answer: event.result.answer || streamedAnswer,
      };
    }

    if (!sawResult) throw new Error('claude_stream_missing_result');

    this.hasStarted = true;
    yield {
      type: 'done',
      result: finalResult ?? {
        answer: streamedAnswer,
        durationMs: null,
        costUsd: null,
        sessionId: this.sessionId,
        warning: null,
      },
    };
  }

  private buildArgs(prompt: string, outputFormat: 'json' | 'stream-json'): string[] {
    const args = [
      '-p',
      '--model',
      this.model,
      '--output-format',
      outputFormat,
      '--max-turns',
      '1',
      '--max-budget-usd',
      this.maxBudgetUsd,
      '--tools',
      '',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--strict-mcp-config',
      '--permission-mode',
      'dontAsk',
      '--disable-slash-commands',
      '--no-chrome',
      '--system-prompt',
      claudeSystemPrompt(),
    ];

    if (outputFormat === 'stream-json') {
      args.push('--include-partial-messages');
    }

    if (this.effort) {
      args.push('--effort', this.effort);
    }

    if (this.bareMode) {
      args.push('--bare');
    }

    if (this.hasStarted) {
      args.push('--resume', this.sessionId);
    } else {
      args.push('--session-id', this.sessionId);
    }

    args.push(prompt);
    return args;
  }
}

export class LocalCodexRecommendationRunner implements RecommendationChatRunner {
  readonly preservesContext = false;

  private readonly timeoutMs: number;
  private readonly model: string | undefined;

  constructor(args: { timeoutMs?: number; model?: string } = {}) {
    const env = serverEnv();
    this.timeoutMs = args.timeoutMs ?? env.TOKENOMIX_CODEX_CHAT_TIMEOUT_MS;
    this.model = args.model ?? env.TOKENOMIX_CODEX_CHAT_MODEL;
  }

  async status(): Promise<RecommendationChatStatus> {
    const command = await resolveCodexCommand();
    if (!command) {
      return {
        available: false,
        configured: false,
        providerDetails: 'managed_by_codex_cli',
        version: null,
        message: 'OpenAI Codex executable was not found in this server process.',
      };
    }

    try {
      const version = await runCommand(command, ['--version'], 5_000);
      if (version.code !== 0) throw new Error('codex_version_failed');
      return {
        available: true,
        configured: true,
        providerDetails: 'managed_by_codex_cli',
        version: version.stdout.trim() || null,
        message: 'OpenAI Codex is available. Provider configuration is managed by Codex CLI.',
      };
    } catch {
      return {
        available: false,
        configured: false,
        providerDetails: 'managed_by_codex_cli',
        version: null,
        message: 'OpenAI Codex is installed but could not be executed by this server process.',
      };
    }
  }

  async ask(prompt: string): Promise<ChatRunResult> {
    const command = await resolveCodexCommand();
    if (!command) throw new Error('codex_unavailable');

    const result = await runCommand(command, this.buildArgs(), this.timeoutMs, {
      stdin: prompt,
      timeoutError: 'codex_timeout',
    });
    const parsed = parseCodexOutput(result.stdout);
    if (result.code !== 0 && !parsed.answer) {
      throw new Error(`codex_exit_${result.code}`);
    }
    return parsed;
  }

  async *stream(prompt: string, signal?: AbortSignal): AsyncIterable<ChatStreamEvent> {
    const command = await resolveCodexCommand();
    if (!command) throw new Error('codex_unavailable');

    const stdoutLines: string[] = [];
    let sawResult = false;
    let streamedAnswer = '';
    let finalResult: ChatRunResult | null = null;

    for await (const line of streamCommand(command, this.buildArgs(), this.timeoutMs, signal, {
      stdin: prompt,
      timeoutError: 'codex_timeout',
    })) {
      stdoutLines.push(line);
      const event = parseCodexStreamLine(line);
      if (!event) continue;
      if (event.type === 'delta') {
        streamedAnswer += event.text;
        yield event;
        continue;
      }

      sawResult = true;
      finalResult = {
        ...event.result,
        answer: event.result.answer || streamedAnswer,
      };
    }

    if (!sawResult) {
      finalResult = parseCodexOutput(stdoutLines.join('\n'));
      sawResult = Boolean(finalResult.answer);
    }
    if (!sawResult || finalResult === null) throw new Error('codex_stream_missing_result');

    yield {
      type: 'done',
      result: {
        ...finalResult,
        answer: finalResult.answer || streamedAnswer,
      },
    };
  }

  private buildArgs(): string[] {
    const args = [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--ephemeral',
      '--ignore-rules',
      '--sandbox',
      'read-only',
    ];
    if (this.model) args.push('--model', this.model);
    args.push('-');
    return args;
  }
}

/**
 * Isolated working directory for chatbot subprocesses.
 *
 * Claude Code writes session JSONL files to ~/.claude/projects/<cwd-hash>/.
 * If the subprocess inherits the server's process.cwd() (the user's project
 * directory), those JSONL files land in the same watched project directory and
 * the watcher ingests them, inflating the user's reported costs.
 *
 * Pointing cwd at a tokenomix-owned temp directory ensures chatbot sessions
 * hash to a separate directory that is NOT under ~/.claude/projects/<project>/,
 * so the watcher never ingests them. Codex chat also runs from this directory
 * and uses `codex exec --ephemeral` so its Ask AI turns are not persisted into
 * ~/.codex/sessions.
 */
const CHAT_SUBPROCESS_CWD = nodePath.join(os.tmpdir(), `tokenomix-chat-${process.pid}`);

/**
 * Ensure the isolated chat subprocess directory exists.
 * Called once at module load; subsequent calls are no-ops if the dir exists.
 */
async function ensureChatCwd(): Promise<void> {
  await mkdir(CHAT_SUBPROCESS_CWD, { recursive: true, mode: 0o700 });
}
// Fire-and-forget: warm up the directory before any spawns occur.
ensureChatCwd().catch((err: unknown) => {
  logEvent('warn', 'chat_cwd_mkdir_failed', {
    err: err instanceof Error ? err.message : String(err),
    path: CHAT_SUBPROCESS_CWD,
  });
});

interface CommandRunOptions {
  stdin?: string;
  timeoutError?: string;
}

function runCommand(
  command: string,
  args: string[],
  timeoutMs: number,
  options: CommandRunOptions = {}
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      // Use the tokenomix-owned temp dir so provider chat sessions are not
      // written under the user's watched project directory.
      cwd: CHAT_SUBPROCESS_CWD,
      env: process.env,
      shell: false,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let didTimeout = false;

    const timer = setTimeout(() => {
      didTimeout = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    if (timer.unref) timer.unref();

    if (options.stdin !== undefined) {
      child.stdin?.write(options.stdin);
      child.stdin?.end();
    }

    child.stdout.on('data', (chunk: Buffer) => {
      stdout = trimText(stdout + chunk.toString('utf8'), MAX_STDOUT_CHARS);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = trimText(stderr + chunk.toString('utf8'), MAX_STDERR_CHARS);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (didTimeout) {
        reject(new Error(options.timeoutError ?? 'claude_timeout'));
        return;
      }
      resolve({ stdout, stderr, code: code ?? 1 });
    });
  });
}

async function* streamCommand(
  command: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
  options: CommandRunOptions = {}
): AsyncIterable<string> {
  const child = spawn(command, args, {
    // Use the tokenomix-owned temp dir. See CHAT_SUBPROCESS_CWD.
    cwd: CHAT_SUBPROCESS_CWD,
    env: process.env,
    shell: false,
    windowsHide: true,
  });

  let stderr = '';
  let didTimeout = false;

  const timer = setTimeout(() => {
    didTimeout = true;
    child.kill('SIGTERM');
  }, timeoutMs);
  if (timer.unref) timer.unref();

  if (options.stdin !== undefined) {
    child.stdin?.write(options.stdin);
    child.stdin?.end();
  }

  const abortHandler = (): void => {
    child.kill('SIGTERM');
  };
  signal?.addEventListener('abort', abortHandler, { once: true });

  const closePromise = new Promise<number>((resolve, reject) => {
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = trimText(stderr + chunk.toString('utf8'), MAX_STDERR_CHARS);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abortHandler);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abortHandler);
      resolve(code ?? 1);
    });
  });

  const lines = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
  try {
    for await (const line of lines) {
      yield line;
    }
  } finally {
    lines.close();
  }

  const code = await closePromise;
  if (signal?.aborted) return;
  if (didTimeout) throw new Error(options.timeoutError ?? 'claude_timeout');
  void code;
  void stderr;
}

type RecommendationChatRunnerRegistry = Partial<Record<ChatProvider, RecommendationChatRunner>>;

interface ChatSessionState {
  sessionSeeded: boolean;
  seededSummary: MetricSummary | null;
  seededStoreVersion: number;
}

function createDefaultRecommendationChatRunners(): Record<ChatProvider, RecommendationChatRunner> {
  return {
    'claude-code': new LocalClaudeRecommendationRunner(),
    codex: new LocalCodexRecommendationRunner(),
  };
}

function isRecommendationChatRunner(value: unknown): value is RecommendationChatRunner {
  const candidate = value as Partial<RecommendationChatRunner> | null;
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    typeof candidate.status === 'function' &&
    typeof candidate.ask === 'function' &&
    typeof candidate.stream === 'function'
  );
}

function normalizeRunnerRegistry(
  input: RecommendationChatRunner | RecommendationChatRunnerRegistry
): RecommendationChatRunnerRegistry {
  if (isRecommendationChatRunner(input)) {
    return { 'claude-code': input, codex: input };
  }
  return input;
}

function disabledLocalModelsStatus(): RecommendationChatStatus {
  return {
    available: false,
    configured: false,
    providerDetails: 'disabled_for_local_models',
    version: null,
    message: 'Ask AI is disabled for Local Models mode.',
  };
}

function emptyRunnerStatus(provider: ChatProvider): RecommendationChatStatus {
  return {
    available: false,
    configured: false,
    providerDetails: provider === 'codex' ? 'managed_by_codex_cli' : 'managed_by_claude_code',
    version: null,
    message: `${providerRuntimeLabel(provider)} chat runner is not configured.`,
  };
}

function initialChatSessionState(): ChatSessionState {
  return {
    sessionSeeded: false,
    seededSummary: null,
    seededStoreVersion: 0,
  };
}

export function recommendationsChatRoute(
  store: IndexStore,
  runners:
    | RecommendationChatRunner
    | RecommendationChatRunnerRegistry = createDefaultRecommendationChatRunners()
): Hono {
  const app = new Hono();
  const runnerRegistry = normalizeRunnerRegistry(runners);
  const sessionStates = new Map<string, ChatSessionState>();
  let activeStream = false;

  function sessionStateFor(
    provider: UsageSourceProviderFilter,
    chatProvider: ChatProvider
  ): ChatSessionState {
    const key = `${chatProvider}:${provider}`;
    const existing = sessionStates.get(key);
    if (existing) return existing;
    const created = initialChatSessionState();
    sessionStates.set(key, created);
    return created;
  }

  function resolveRequestProvider(rawProvider?: string): UsageSourceProviderFilter | null {
    const parsed = parseUsageProviderFilterParam(rawProvider);
    return parsed === null ? null : defaultProviderFilter(parsed);
  }

  function resolveRunner(provider: UsageSourceProviderFilter): {
    provider: ChatProvider | null;
    runner: RecommendationChatRunner | null;
  } {
    const chatProvider = chatProviderFor(provider);
    if (chatProvider === null) return { provider: null, runner: null };
    return { provider: chatProvider, runner: runnerRegistry[chatProvider] ?? null };
  }

  app.get('/status', async (c) => {
    const provider = resolveRequestProvider(c.req.query('provider'));
    if (provider === null) return c.json({ error: 'Invalid provider filter.' }, 400);
    const resolved = resolveRunner(provider);
    if (resolved.provider === null) return c.json(disabledLocalModelsStatus());
    if (resolved.runner === null) return c.json(emptyRunnerStatus(resolved.provider));

    const status = await resolved.runner.status();
    return c.json(status);
  });

  app.post('/', async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body.' }, 400);
    }

    const request = validateRequest(raw);
    if (!request) {
      return c.json({ error: 'Message is required and must be 2,000 characters or fewer.' }, 400);
    }

    const provider = defaultProviderFilter(request.provider);
    const resolved = resolveRunner(provider);
    if (resolved.provider === null) {
      return c.json({ error: 'Ask AI is disabled for Local Models mode.' }, 400);
    }
    if (resolved.runner === null) {
      return c.json(
        { error: `${providerRuntimeLabel(resolved.provider)} chat runner is not configured.` },
        503
      );
    }

    const runner = resolved.runner;
    const runtimeLabel = providerRuntimeLabel(resolved.provider);
    const state = sessionStateFor(provider, resolved.provider);
    const canReuseSeed = runner.preservesContext === true;
    const hasCurrentSeed =
      canReuseSeed &&
      state.sessionSeeded &&
      state.seededSummary !== null &&
      state.seededStoreVersion === store.lastChangeTs;
    const summary =
      hasCurrentSeed && state.seededSummary
        ? state.seededSummary
        : store.getMetrics({ since: 'all', ...providerQuery(metricsProviderFilter(provider)) });
    const retrievedContext = buildRetrievedChatContext({
      store,
      summary,
      request,
      includeBaseline: !hasCurrentSeed,
      provider,
    });
    const prompt = hasCurrentSeed
      ? buildFollowupPrompt(request, retrievedContext)
      : buildPrompt(request, retrievedContext);

    try {
      const answer = await runner.ask(prompt);
      if (canReuseSeed) {
        state.sessionSeeded = true;
        state.seededSummary = summary;
        state.seededStoreVersion = store.lastChangeTs;
      }
      const responseText = answer.answer || `${runtimeLabel} returned an empty response.`;
      const response: RecommendationChatResponse = {
        answer: responseText,
        groundedOpportunityIds: groundedOpportunityIds(summary, responseText),
        durationMs: answer.durationMs,
        costUsd: answer.costUsd,
        sessionId: answer.sessionId,
        warning: answer.warning,
      };
      return c.json(response);
    } catch {
      state.sessionSeeded = false;
      state.seededSummary = null;
      return c.json(
        {
          error: `${runtimeLabel} request failed. Confirm ${runtimeLabel} works in this server process context.`,
        },
        502
      );
    }
  });

  app.post('/stream', async (c) => {
    if (activeStream) {
      return c.json({ error: 'A recommendation chat response is already in progress.' }, 409);
    }

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body.' }, 400);
    }

    const request = validateRequest(raw);
    if (!request) {
      return c.json({ error: 'Message is required and must be 2,000 characters or fewer.' }, 400);
    }

    const provider = defaultProviderFilter(request.provider);
    const resolved = resolveRunner(provider);
    if (resolved.provider === null) {
      return c.json({ error: 'Ask AI is disabled for Local Models mode.' }, 400);
    }
    if (resolved.runner === null) {
      return c.json(
        { error: `${providerRuntimeLabel(resolved.provider)} chat runner is not configured.` },
        503
      );
    }

    const runner = resolved.runner;
    const runtimeLabel = providerRuntimeLabel(resolved.provider);
    const state = sessionStateFor(provider, resolved.provider);
    const canReuseSeed = runner.preservesContext === true;
    const hasCurrentSeed =
      canReuseSeed &&
      state.sessionSeeded &&
      state.seededSummary !== null &&
      state.seededStoreVersion === store.lastChangeTs;
    const summary =
      hasCurrentSeed && state.seededSummary
        ? state.seededSummary
        : store.getMetrics({ since: 'all', ...providerQuery(metricsProviderFilter(provider)) });
    const retrievedContext = buildRetrievedChatContext({
      store,
      summary,
      request,
      includeBaseline: !hasCurrentSeed,
      provider,
    });
    const prompt = hasCurrentSeed
      ? buildFollowupPrompt(request, retrievedContext)
      : buildPrompt(request, retrievedContext);

    activeStream = true;
    return streamSSE(c, async (stream) => {
      const abortController = new AbortController();
      stream.onAbort(() => {
        abortController.abort();
        activeStream = false;
      });

      let responseText = '';

      try {
        await stream.writeSSE({
          event: 'message',
          data: JSON.stringify({ type: 'start', sessionSeeded: hasCurrentSeed }),
        });

        for await (const event of runner.stream(prompt, abortController.signal)) {
          if (event.type === 'delta') {
            responseText += event.text;
            await stream.writeSSE({
              event: 'message',
              data: JSON.stringify({ type: 'delta', text: event.text }),
            });
            continue;
          }

          responseText = event.result.answer || responseText;
          if (canReuseSeed) {
            state.sessionSeeded = true;
            state.seededSummary = summary;
            state.seededStoreVersion = store.lastChangeTs;
          }
          await stream.writeSSE({
            event: 'message',
            data: JSON.stringify({
              type: 'done',
              result: {
                answer: responseText || `${runtimeLabel} returned an empty response.`,
                groundedOpportunityIds: groundedOpportunityIds(summary, responseText),
                durationMs: event.result.durationMs,
                costUsd: event.result.costUsd,
                sessionId: event.result.sessionId,
                warning: event.result.warning,
              },
            }),
          });
        }
      } catch {
        state.sessionSeeded = false;
        state.seededSummary = null;
        await stream.writeSSE({
          event: 'message',
          data: JSON.stringify({
            type: 'error',
            error: `${runtimeLabel} request failed. Confirm ${runtimeLabel} works in this server process context.`,
          }),
        });
      } finally {
        activeStream = false;
      }
    });
  });

  return app;
}
