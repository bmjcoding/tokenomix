# Pilot readiness

Date: 2026-05-03

This document is the controlled-pilot checklist for the multi-provider
tokenomix rollout. It records what is verified, what is estimated, what must be
reviewed before each pilot batch, and how to collect local-model telemetry.

## Pilot scope

The current rollout target is a local, single-user dashboard for:

- Claude Code logs from `~/.claude/projects/**/*.jsonl`
- OpenAI Codex logs from `~/.codex/sessions/**/*.jsonl` and
  `~/.codex/archived_sessions/*.jsonl`
- Local-model telemetry from `~/.tokenomix/local-models/**/*.jsonl`

The dashboard remains localhost-only. It is not a hosted multi-user service and
does not include server-side authentication, central storage, or shared billing
aggregation.

## Readiness verdict

Pilot-ready means all of the following are true on the release candidate:

- `corepack pnpm@10.33.0 install` completes without lockfile drift.
- `corepack pnpm@10.33.0 typecheck` passes.
- `corepack pnpm@10.33.0 lint` passes.
- `corepack pnpm@10.33.0 test` passes.
- `corepack pnpm@10.33.0 build` passes.
- `corepack pnpm@10.33.0 audit --audit-level moderate` reports no known
  moderate-or-higher vulnerabilities.
- `corepack pnpm@10.33.0 verify:pricing` passes against official Anthropic and
  OpenAI/Codex pricing pages.
- A built-server smoke test returns `200` from `/api/metrics`.
- Ask AI status returns disabled for `provider=local-models`.
- Ask AI status returns a Codex CLI version for `provider=codex` when Codex is
  installed.
- `git diff --check` passes.
- A secret scan over changed and untracked files passes.

Do not expand beyond a controlled pilot if any validation fails.

## Pricing guarantees

### Claude Code

Claude Code pricing remains the strongest guarantee:

- Usage source: assistant usage blocks in Claude Code JSONL.
- Deduplication: `(requestId, message.id)`.
- Cost precision: integer micro-USD calculations.
- Verified by: `apps/server/scripts/verify-anthropic-pricing.ts`.
- Official source: Anthropic Claude pricing documentation.

Supported modifiers include prompt-cache write/read rates, Batch API discount,
Claude fast mode where logs expose `speed=fast`, US-only inference where logs
expose `inference_geo`, and Bedrock endpoint premium handling when configured.

### OpenAI Codex

OpenAI Codex rows are token-counted from Codex `token_count` events and priced
when the model is recognized.

Supported model coverage:

| Model | Pricing source | Notes |
| --- | --- | --- |
| `gpt-5.5` | OpenAI API pricing | Standard-speed, short/long context aware |
| `gpt-5.4` | OpenAI API pricing | Standard-speed, short/long context aware |
| `gpt-5.4-mini` | OpenAI API pricing | Standard-speed only |
| `gpt-5.3-codex` | Codex rate card | USD-equivalent estimate from credits |
| `gpt-5.2` | Codex rate card | USD-equivalent estimate from credits |
| `gpt-5.3-codex-spark` | Unpriced | Research-preview rates are not final |

The Codex verifier checks:

- API pricing rows for `gpt-5.5`, `gpt-5.4`, and `gpt-5.4-mini`.
- Model-page long-context rules for `gpt-5.5` and `gpt-5.4`.
- Codex token-based credit rows for `gpt-5.5`, `gpt-5.4`,
  `gpt-5.3-codex`, and `gpt-5.2`.
- Codex Fast mode multipliers for supported models.
- The Codex API-key note that API-key usage uses standard API pricing rather
  than Fast mode credits.

OpenAI long-context pricing is applied when captured input tokens exceed
272,000 for `gpt-5.5` or `gpt-5.4`. Input and cached-input rates double, and
output rates use the documented 1.5x long-context rate.

Known Codex limits:

- Local Codex JSONL does not expose per-turn Fast mode state. Fast mode
  multipliers are documented and surfaced in audit warnings but cannot be
  applied or ruled out from the log alone.
- Local Codex JSONL does not identify whether the session was billed through
  ChatGPT credits or an API key. Rate-card-only rows are therefore
  USD-equivalent estimates, not invoice totals.
- Codex web-search calls are counted as tool activity but not separately added
  to Codex cost because the local log does not expose a stable tool-fee billing
  mode.
- Regional-processing uplifts are not applied to Codex rows because local Codex
  logs do not expose a per-turn processing region.

### Local models

Local-model rows are not actual spend. The primary dashboard cost field is a
counterfactual Claude Sonnet-equivalent estimate, and each row also stores an
OpenAI Codex/GPT-5.5-equivalent estimate for comparison surfaces.

This supports two pilot goals:

- Compare local usage to what the same token shape would roughly cost on Claude
  Code or OpenAI Codex.
- Optimize token shape, cache behavior, TTFT, and tokens-per-second for faster
  local responses.

Actual local runtime spend is `$0` before hardware, power, hosting, and operator
time. The dashboard must not be presented as a local-model invoice.

## Local telemetry contract

Write JSONL files under `~/.tokenomix/local-models/`. Each line must contain a
timestamp, model ID, and input/output token counts. The parser accepts these
shapes.

### Normalized tokenomix record

```json
{
  "timestamp": "2026-05-03T15:00:00.000Z",
  "runtime": "ollama",
  "session_id": "pilot-001",
  "cwd": "/Users/alex/work/app",
  "model": "qwen3:14b",
  "usage": {
    "input_tokens": 1200,
    "cached_input_tokens": 300,
    "output_tokens": 220,
    "reasoning_output_tokens": 40
  },
  "metrics": {
    "duration_ms": 8400,
    "time_to_first_token_ms": 620,
    "prompt_eval_duration_ms": 900,
    "eval_duration_ms": 6500,
    "tokens_per_second": 33.8
  },
  "tool_uses": {
    "read_file": 2
  }
}
```

### Ollama final response

Ollama final response objects are accepted when they include fields such as
`prompt_eval_count`, `eval_count`, `total_duration`, `load_duration`,
`prompt_eval_duration`, and `eval_duration`. Ollama durations are nanoseconds.

### LM Studio response

LM Studio response objects are accepted when they include `stats.input_tokens`,
`stats.total_output_tokens`, `stats.tokens_per_second`, and
`stats.time_to_first_token_seconds`.

### OpenAI-compatible local response

OpenAI-compatible local servers are accepted when they include numeric
`created`, `model`, `usage.prompt_tokens`, and `usage.completion_tokens`.
Cached-token details are read from
`usage.prompt_tokens_details.cached_tokens` when present.

### OpenCode JSON step finish

OpenCode-style `step_finish` JSONL lines are accepted when the line includes a
model ID and `part.tokens.input` / `part.tokens.output`.

```json
{
  "type": "step_finish",
  "timestamp": 1777817320000,
  "sessionID": "ses_local_001",
  "model": "ollama/qwen3-coder:30b",
  "part": {
    "type": "step-finish",
    "tokens": {
      "input": 1500,
      "output": 300,
      "reasoning": 50,
      "cache": {
        "read": 200
      }
    }
  }
}
```

If an OpenCode line does not include a model ID, tokenomix rejects it rather
than guessing. Use the normalized record shape in that case.

## Local tokenizer fallback

Tokenizer fallback is intentionally not enabled by default. It can be added
later as an explicit opt-in, but it should not be used as the pilot baseline.

Reasons:

- It requires reading prompt and response text, which weakens the current
  token-only ingestion posture.
- Counts can drift when chat templates, system prompts, tool schemas, image
  inputs, speculative decoding, or runtime-side prompt expansion differ from
  the tokenizer pass.
- Runtime-emitted usage is the only source that can align with performance
  metrics such as TTFT and tokens-per-second.

## Ask AI provider behavior

- `Claude Code` and `All providers` use the Claude Code subprocess runner.
- `OpenAI Codex` uses `codex exec --json` through the local Codex CLI.
- `Local Models` hides Ask AI for now.

The Codex runner uses non-interactive JSONL output, stdin prompt input,
ephemeral session mode, read-only sandboxing, and ignored project/user rules for
recommendation-chat isolation.

## Pilot operator checklist

For each pilot participant:

- Confirm Node 22+ and pnpm 10.33.0 through Corepack.
- Confirm Claude Code, OpenAI Codex, or local runtime logs are present in the
  expected directories.
- For local-heavy users, install a lightweight adapter that appends accepted
  JSONL records to `~/.tokenomix/local-models/`.
- Run `corepack pnpm@10.33.0 verify:pricing` on the candidate build.
- Start the app with an unused `PORT_BASE`.
- Open `/api/metrics?provider=claude-code`, `/api/metrics?provider=codex`, and
  `/api/metrics?provider=local-models` to confirm provider isolation.
- Review the hero data-quality tooltip warnings before accepting any cost
  number as pilot evidence.
- Export reports only after checking `pricingAudit.warnings` and
  `ingestionAudit.warnings`.

## Rollout stop conditions

Stop the pilot and fix before adding more users if any of these occur:

- Known priced models appear as `unpriced_provider` unexpectedly.
- `verify:pricing` fails against official sources.
- Local-model users cannot emit runtime token counts.
- Ingestion warnings show repeated invalid JSON, unreadable files, or schema
  mismatches from a pilot adapter.
- Codex users rely on Fast mode and require exact dollar/credit accounting from
  local logs.
- The user needs hosted multi-user security, central billing, or shared
  workspace reporting.

## Source references

- Anthropic Claude pricing:
  `https://platform.claude.com/docs/en/about-claude/pricing`
- OpenAI API pricing:
  `https://developers.openai.com/api/docs/pricing`
- OpenAI GPT-5.5 model pricing:
  `https://developers.openai.com/api/docs/models/gpt-5.5`
- OpenAI GPT-5.4 model pricing:
  `https://developers.openai.com/api/docs/models/gpt-5.4`
- OpenAI Codex rate card:
  `https://help.openai.com/en/articles/20001106-codex-rate-card`
- OpenAI Codex speed/Fast mode:
  `https://developers.openai.com/codex/speed`
- Ollama usage metrics:
  `https://docs.ollama.com/api/usage`
- LM Studio REST API stats:
  `https://lmstudio.ai/docs/developer/rest/endpoints`
