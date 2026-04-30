/**
 * Local Claude Code chat route for Optimization Opportunities.
 *
 * The server treats Claude Code as an opaque local executable. Enterprise
 * gateway URLs and credentials remain in Claude Code settings/environment and
 * are never read or exposed by tokenomix.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
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
} from '@tokenomix/shared';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { IndexStore } from '../index-store.js';

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

export interface ClaudeRunResult {
  answer: string;
  durationMs: number | null;
  costUsd: number | null;
  sessionId: string | null;
  warning: string | null;
}

export type ClaudeStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; result: ClaudeRunResult };

export interface ClaudeRecommendationRunner {
  status(): Promise<RecommendationChatStatus>;
  ask(prompt: string): Promise<ClaudeRunResult>;
  stream(prompt: string, signal?: AbortSignal): AsyncIterable<ClaudeStreamEvent>;
}

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
  return {
    message,
    history: sanitizeHistory(body.history),
  };
}

function buildChatContext(summary: MetricSummary): unknown {
  return {
    window: 'absolute last 30 local calendar days unless noted otherwise',
    costUsd30d: roundCurrency(summary.costUsd30d),
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

function compactTurn(turn: SessionTurnRow, rank: number): unknown {
  return {
    rank,
    timestamp: turn.timestamp,
    modelFamily: turn.modelFamily,
    modelId: turn.modelId,
    costUsd: roundCurrency(turn.costUsd),
    inputTokens: turn.inputTokens,
    outputTokens: turn.outputTokens,
    cacheReadTokens: turn.cacheReadTokens,
    durationMs: turn.durationMs,
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
    .map((turn, index) => compactTurn(turn, index + 1));

  return {
    sessionId: detail.sessionId,
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

function findSessionIdsForQuestion(store: IndexStore, question: string): string[] {
  const terms = extractIdentifierTerms(question);
  if (terms.length === 0) return [];

  const matches = new Set<string>();
  for (const row of store.rows.values()) {
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
  projectPath: string
): unknown {
  const projectName = basename(projectPath);
  const allTime = summary.byProject.find((project) => project.project === projectPath);
  const last30d = summary.byProject30d.find((project) => project.project === projectPath);
  const sessions = store
    .getSessions({ project: projectPath })
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
      .getTurns({ project: projectPath }, MAX_CONTEXT_TURNS)
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
}): unknown | null {
  const { store, summary, request, includeBaseline } = args;
  const sessionIds = findSessionIdsForQuestion(store, request.message);
  const matchedSessions = sessionIds
    .map((sessionId) => store.getSessionDetail(sessionId))
    .filter((detail): detail is SessionDetail => detail !== null)
    .map(compactSessionDetail);
  const projectPaths = findProjectsForQuestion(summary, request.message);
  const matchedProjects = projectPaths.map((projectPath) =>
    buildProjectContext(store, summary, projectPath)
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
    sourceBoundary:
      'Indexed Claude Code usage under ~/.claude/projects only; no arbitrary filesystem reads and no full transcript text.',
    mode: includeBaseline ? 'baseline-plus-targeted-retrieval' : 'targeted-followup-retrieval',
    baseline: includeBaseline ? buildChatContext(summary) : undefined,
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
      ? store.getSessions({}).slice(0, MAX_CONTEXT_SESSIONS).map(compactSessionSummary)
      : undefined,
    topExpensiveTurns: includeTurns
      ? store.getTurns({}, MAX_CONTEXT_TURNS).map((turn, index) => ({
          rank: index + 1,
          sessionId: turn.sessionId,
          project: basename(turn.project),
          timestamp: turn.timestamp,
          modelFamily: turn.modelFamily,
          modelId: turn.modelId,
          costUsd: roundCurrency(turn.costUsd),
          inputTokens: turn.inputTokens,
          outputTokens: turn.outputTokens,
          cacheReadTokens: turn.cacheReadTokens,
          durationMs: turn.durationMs,
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
        'Use the Tokenomix metrics context already supplied earlier in this Claude Code session.',
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

async function executableExists(command: string): Promise<boolean> {
  try {
    await access(command);
    return true;
  } catch {
    return false;
  }
}

async function resolveClaudeCommand(): Promise<string | null> {
  const configured = process.env.TOKENOMIX_CLAUDE_COMMAND?.trim();
  if (configured) return configured;

  const homeCandidate = nodePath.join(os.homedir(), '.local', 'bin', 'claude');
  if (await executableExists(homeCandidate)) return homeCandidate;

  return 'claude';
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
  private readonly timeoutMs: number;
  private readonly maxBudgetUsd: string;
  private readonly model: string;
  private readonly sessionId: string;
  private readonly effort: string | null;
  private readonly bareMode: boolean;
  private hasStarted = false;

  constructor(args: { timeoutMs?: number; maxBudgetUsd?: string } = {}) {
    this.timeoutMs =
      args.timeoutMs ?? Number(process.env.TOKENOMIX_CLAUDE_CHAT_TIMEOUT_MS ?? 60_000);
    this.maxBudgetUsd =
      args.maxBudgetUsd ?? process.env.TOKENOMIX_CLAUDE_CHAT_MAX_BUDGET_USD ?? '0.05';
    this.model = process.env.TOKENOMIX_CLAUDE_CHAT_MODEL?.trim() || 'sonnet';
    this.sessionId = randomUUID();
    this.effort = normalizeClaudeEffort(process.env.TOKENOMIX_CLAUDE_CHAT_EFFORT);
    this.bareMode = ['1', 'true', 'yes'].includes(
      process.env.TOKENOMIX_CLAUDE_CHAT_BARE?.toLowerCase() ?? ''
    );
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

function runCommand(
  command: string,
  args: string[],
  timeoutMs: number
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
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
        reject(new Error('claude_timeout'));
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
  signal?: AbortSignal
): AsyncIterable<string> {
  const child = spawn(command, args, {
    cwd: process.cwd(),
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
  if (didTimeout) throw new Error('claude_timeout');
  void code;
  void stderr;
}

export function recommendationsChatRoute(
  store: IndexStore,
  runner: ClaudeRecommendationRunner = new LocalClaudeRecommendationRunner()
): Hono {
  const app = new Hono();
  let sessionSeeded = false;
  let activeStream = false;
  let seededSummary: MetricSummary | null = null;
  let seededStoreVersion = 0;

  app.get('/status', async (c) => {
    const status = await runner.status();
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

    const hasCurrentSeed =
      sessionSeeded && seededSummary !== null && seededStoreVersion === store.lastChangeTs;
    const summary =
      hasCurrentSeed && seededSummary ? seededSummary : store.getMetrics({ since: 'all' });
    const retrievedContext = buildRetrievedChatContext({
      store,
      summary,
      request,
      includeBaseline: !hasCurrentSeed,
    });
    const prompt = hasCurrentSeed
      ? buildFollowupPrompt(request, retrievedContext)
      : buildPrompt(request, retrievedContext);

    try {
      const answer = await runner.ask(prompt);
      sessionSeeded = true;
      seededSummary = summary;
      seededStoreVersion = store.lastChangeTs;
      const responseText = answer.answer || 'Claude Code returned an empty response.';
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
      return c.json(
        {
          error:
            'Claude Code request failed. Confirm Claude Code works in this server process context.',
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

    const hasCurrentSeed =
      sessionSeeded && seededSummary !== null && seededStoreVersion === store.lastChangeTs;
    const summary =
      hasCurrentSeed && seededSummary ? seededSummary : store.getMetrics({ since: 'all' });
    const retrievedContext = buildRetrievedChatContext({
      store,
      summary,
      request,
      includeBaseline: !hasCurrentSeed,
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
          data: JSON.stringify({ type: 'start', sessionSeeded }),
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
          sessionSeeded = true;
          seededSummary = summary;
          seededStoreVersion = store.lastChangeTs;
          await stream.writeSSE({
            event: 'message',
            data: JSON.stringify({
              type: 'done',
              result: {
                answer: responseText || 'Claude Code returned an empty response.',
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
        await stream.writeSSE({
          event: 'message',
          data: JSON.stringify({
            type: 'error',
            error:
              'Claude Code request failed. Confirm Claude Code works in this server process context.',
          }),
        });
      } finally {
        activeStream = false;
      }
    });
  });

  return app;
}
