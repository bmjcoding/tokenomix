#!/usr/bin/env python3
"""Aggregate REAL Claude Code API usage from conversation logs.

Recursively reads `~/.claude/projects/<project>/**/*.jsonl` — both top-level
session logs AND nested `<session>/subagents/agent-XXX.jsonl` files. Extracts
the `message.usage` blocks that record actual input/output/cache token counts
as billed by the API. Uses per-model pricing (reading `message.model` per
event) so Opus/Sonnet/Haiku costs are computed correctly.

Deduplicates by (requestId, message.id):
    Claude Code stores multi-block API responses (e.g., a thinking block + a
    text block from one API call) as separate events with the SAME usage
    block. The usage represents the entire API call's billed tokens. Counting
    once per (requestId, message.id) avoids the ~2x inflation that comes from
    counting once per event.

Why this exists:
    `retro-trends.py` reads optional, configured retro history files. Those
    files only contain structured pipeline summaries — a tiny subset of total
    usage. Most agent dispatches, direct conversations, one-off tasks, and
    failed sessions never make it to a retro. This script scans ALL conversation
    logs and reports actual API spend with cache-aware, model-aware pricing.

Usage:
    claude-usage.py totals              [--since DAYS] [--project NAME]
    claude-usage.py daily               [--since DAYS]
    claude-usage.py by-project          [--since DAYS] [--top N]
    claude-usage.py by-session          [--since DAYS] [--top N]
    claude-usage.py by-model            [--since DAYS]
    claude-usage.py weekly              [--since DAYS]
    claude-usage.py report              [--since DAYS] [--output FILE]

Pricing (per Anthropic public pricing page at platform.claude.com; override via
--price-* flags). Each model family is split by version because Opus 4.5+ and
Haiku 3 vs 3.5 vs 4.5 use different rates:

    Claude Opus 4.5 / 4.6 / 4.7   (modern Opus, 3x cheaper than 4.x):
        input              $5.00 / 1M tokens
        output            $25.00 / 1M tokens
        cache_creation_5m  $6.25 / 1M tokens
        cache_creation_1h $10.00 / 1M tokens
        cache_read         $0.50 / 1M tokens

    Claude Opus 3 / 4.0 / 4.1     (legacy Opus, deprecated or pre-4.5):
        input             $15.00 / 1M tokens
        output            $75.00 / 1M tokens
        cache_creation_5m $18.75 / 1M tokens
        cache_creation_1h $30.00 / 1M tokens
        cache_read         $1.50 / 1M tokens

    Claude Sonnet 3.7 / 4 / 4.5 / 4.6  (one rate across all current Sonnets):
        input              $3.00 / 1M tokens
        output            $15.00 / 1M tokens
        cache_creation_5m  $3.75 / 1M tokens
        cache_creation_1h  $6.00 / 1M tokens
        cache_read         $0.30 / 1M tokens

    Claude Haiku 4.5:
        input              $1.00 / 1M tokens
        output             $5.00 / 1M tokens
        cache_creation_5m  $1.25 / 1M tokens
        cache_creation_1h  $2.00 / 1M tokens
        cache_read         $0.10 / 1M tokens

    Claude Haiku 3.5:
        input              $0.80 / 1M tokens
        output             $4.00 / 1M tokens
        cache_creation_5m  $1.00 / 1M tokens
        cache_creation_1h  $1.60 / 1M tokens
        cache_read         $0.08 / 1M tokens

    Claude Haiku 3:
        input              $0.25 / 1M tokens
        output             $1.25 / 1M tokens
        cache_creation_5m  $0.30 / 1M tokens
        cache_creation_1h  $0.50 / 1M tokens
        cache_read         $0.03 / 1M tokens

    Unknown / synthetic events default to Sonnet pricing (most common tier).
    Synthetic events (model="<synthetic>") have zero billed tokens in practice.

Cache reads typically dominate the raw token count (often 90%+) because every
conversation turn re-reads the system prompt and prior context. Effective
$/Mtok-blended is therefore much lower than the marginal input price.

Additional official pricing handled from Claude Code usage blocks:
    - Web search: $10 / 1,000 searches, charged in addition to token costs.
    - Batch service tier: 0.5x token pricing.
    - Fast mode: 6x token pricing for currently supported model IDs.
    - US-only inference: 1.1x token pricing for Opus 4.6/4.7 and newer models.

Exit codes:
    0  success
    1  no logs found
    2  invalid invocation
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from tokenomix_config import TokenomixConfig, expand_path, expand_prefix, load_config


WEB_SEARCH_USD_PER_REQUEST = 10.00 / 1_000


def is_excluded_cwd(cwd: str, prefixes: list[str]) -> bool:
    """Return True iff `cwd` is inside any configured exclusion prefix.

    Matches an exact prefix or a child path separated by `/`. A bare substring
    check would
    misfire on names like "my-excluded-project" — anchor on path boundaries.
    """
    normalized = cwd.rstrip("/")
    for p in prefixes:
        if normalized == p or normalized.startswith(p + "/"):
            return True
    return False


def is_cowork_cwd(cwd: str, prefixes: list[str] | None = None) -> bool:
    """Deprecated compatibility alias for the original exclusion helper."""
    return is_excluded_cwd(cwd, prefixes or [])


def config_for_args(args) -> TokenomixConfig:
    config = load_config(getattr(args, "config", None))
    projects_dir = getattr(args, "projects_dir", None)
    if projects_dir:
        config = TokenomixConfig(
            config_path=config.config_path,
            claude_home=config.claude_home,
            projects_dir=expand_path(projects_dir),
            exclude_cwd_prefixes=config.exclude_cwd_prefixes,
            retro_history_paths=config.retro_history_paths,
        )
    return config

# Per-model pricing tables (USD per 1M tokens). Source: Anthropic public pricing
# page (https://platform.claude.com/docs/en/about-claude/pricing). Override with
# --price-* CLI flags if needed.
#
# Family keys are version-aware because Anthropic's pricing changed at the
# Opus 4.5 release (3x cheaper across the board) and Haiku also varies by
# version. Mis-applying a legacy rate to a modern call inflates costs by 3x.
MODEL_PRICES: dict[str, dict[str, float]] = {
    # Opus 4.5 / 4.6 / 4.7 — modern Opus, current pricing.
    "opus": {
        "input":              5.00,
        "output":             25.00,
        "cache_creation_5m":  6.25,
        "cache_creation_1h":  10.00,
        "cache_read":         0.50,
    },
    # Opus 3 / 4.0 / 4.1 — legacy Opus, 3x more expensive than modern.
    "opus_legacy": {
        "input":              15.00,
        "output":             75.00,
        "cache_creation_5m":  18.75,
        "cache_creation_1h":  30.00,
        "cache_read":         1.50,
    },
    # Sonnet 3.7 / 4 / 4.5 / 4.6 — single rate across all current Sonnets.
    "sonnet": {
        "input":              3.00,
        "output":             15.00,
        "cache_creation_5m":  3.75,
        "cache_creation_1h":  6.00,
        "cache_read":         0.30,
    },
    # Haiku 4.5 — current Haiku.
    "haiku": {
        "input":              1.00,
        "output":             5.00,
        "cache_creation_5m":  1.25,
        "cache_creation_1h":  2.00,
        "cache_read":         0.10,
    },
    # Haiku 3.5 — legacy Haiku, slightly cheaper than 4.5.
    "haiku_3_5": {
        "input":              0.80,
        "output":             4.00,
        "cache_creation_5m":  1.00,
        "cache_creation_1h":  1.60,
        "cache_read":         0.08,
    },
    # Haiku 3 — oldest Haiku, deepest discount.
    "haiku_3": {
        "input":              0.25,
        "output":             1.25,
        "cache_creation_5m":  0.30,
        "cache_creation_1h":  0.50,
        "cache_read":         0.03,
    },
}

# Default to sonnet for unknown/synthetic events (most common tier).
# Synthetic events have zero billable tokens in practice so this is safe.
DEFAULT_PRICES = MODEL_PRICES["sonnet"]

# Compiled regex to extract the major.minor version from a model id like
# "claude-opus-4-7" → (4, 7) or "claude-haiku-4-5" → (4, 5). The "claude-X-N-M"
# convention is stable; older IDs use "claude-X-N" (single-digit) so we tolerate
# missing minor.
_MODEL_VERSION_RE = re.compile(r"claude-(?:opus|sonnet|haiku)-(\d+)(?:-(\d+))?")


def _model_version(model_id: str) -> tuple[int, int]:
    """Return the (major, minor) version from a model id, or (0, 0) if unknown."""
    m = _MODEL_VERSION_RE.match(model_id.lower())
    if not m:
        return (0, 0)
    major = int(m.group(1))
    minor = int(m.group(2)) if m.group(2) else 0
    return (major, minor)


def model_family(model_id: str | None) -> str:
    """Map a raw model id (e.g. claude-opus-4-7) to a pricing family key.

    Version-aware: Opus 4.5+ uses different pricing than Opus 4 / 4.1, and
    Haiku has three pricing tiers (3, 3.5, 4.5+). Misclassifying these
    inflates or deflates cost by up to 3x.
    """
    if not model_id:
        return "sonnet"
    m = model_id.lower()
    if "opus" in m:
        major, minor = _model_version(m)
        # Opus 4.5+ uses the modern (cheaper) pricing. Earlier Opus uses legacy.
        # Default unmatched Opus to modern pricing — Anthropic does not ship
        # Opus on the legacy schedule for new releases.
        if (major, minor) >= (4, 5) or (major, minor) == (0, 0):
            return "opus"
        return "opus_legacy"
    if "haiku" in m:
        major, minor = _model_version(m)
        if (major, minor) >= (4, 0) or (major, minor) == (0, 0):
            return "haiku"
        if (major, minor) >= (3, 5):
            return "haiku_3_5"
        return "haiku_3"
    if "sonnet" in m:
        return "sonnet"
    # Synthetic events ("<synthetic>") and unknown IDs price as sonnet.
    return "sonnet"


def prices_for_model(model_id: str | None,
                      override: dict[str, float] | None) -> dict[str, float]:
    """Return the price table for a given model, applying any CLI overrides
    on top of the model family's defaults."""
    family = model_family(model_id)
    base = dict(MODEL_PRICES[family])
    if override:
        base.update(override)
    return base


def _data_residency_applies(model_id: str | None) -> bool:
    """Return whether US-only inference carries the current 1.1x multiplier."""
    if not model_id:
        return False
    major, minor = _model_version(model_id)
    # Official pricing applies US-only inference to Opus 4.6, Opus 4.7, and
    # newer models. Treat 4.6+ model IDs as in-scope and earlier IDs as legacy.
    return (major, minor) >= (4, 6)


def _fast_mode_applies(model_id: str | None) -> bool:
    """Return whether the current official fast-mode premium applies."""
    if not model_id:
        return False
    m = model_id.lower()
    major, minor = _model_version(m)
    # Official pricing currently lists fast mode only for Claude Opus 4.6.
    return "opus" in m and (major, minor) == (4, 6)


def pricing_multiplier_for_usage(model_id: str | None, usage: dict) -> float:
    """Return multiplicative token-pricing modifiers for one usage block.

    These stack with base token/cache prices. Separate per-use charges, such as
    web search requests, are handled outside this multiplier.
    """
    multiplier = 1.0

    service_tier = str(usage.get("service_tier") or "").lower()
    if service_tier == "batch":
        multiplier *= 0.5

    speed = str(usage.get("speed") or "").lower()
    if speed == "fast" and _fast_mode_applies(model_id):
        multiplier *= 6.0

    inference_geo = str(usage.get("inference_geo") or "").lower().replace("-", "_")
    if inference_geo in {"us", "usa", "us_only", "united_states"} and _data_residency_applies(model_id):
        multiplier *= 1.1

    return multiplier


def parse_iso(ts: str | None) -> datetime | None:
    """Parse an Anthropic-emitted ISO-8601 timestamp into a naive *local* datetime.

    Anthropic logs append `Z` (UTC). The previous implementation stripped `Z`
    and parsed the result as naive — meaning a UTC instant was treated as if
    it were already local time. For any user not in UTC, this shifted events
    into the wrong calendar day for daily bucketing. We now parse `Z` as
    explicit UTC, convert to the system's local time zone, then drop the
    tz-info so downstream comparisons against naive `datetime.now()` cutoffs
    keep working without further changes.
    """
    if not ts:
        return None
    try:
        if ts.endswith("Z"):
            aware_utc = datetime.fromisoformat(ts[:-1] + "+00:00")
            return aware_utc.astimezone().replace(tzinfo=None)
        # No timezone marker — try as-is, then a tolerant fallback.
        return datetime.fromisoformat(ts)
    except ValueError:
        try:
            return datetime.strptime(ts[:19], "%Y-%m-%dT%H:%M:%S")
        except ValueError:
            return None


def project_name_from_path(p: Path) -> str:
    """Decode Claude Code's project-dir naming back to a readable path.

    Claude Code's encoding is LOSSY:
        /Users/example/.claude             → -Users-example--claude
        /Users/example/src/app-with-hyphen → -Users-example-src-app-with-hyphen
    The decoder cannot distinguish a hyphen-as-separator from a literal hyphen
    in a directory name (e.g., `app-with-hyphen` vs `app/with/hyphen`).

    The fix used elsewhere: read the actual `cwd` field from the first log
    event in the project's session files. This function is the LAST RESORT
    fallback for cases where no log event has a `cwd` field.
    """
    name = p.parent.name if p.is_file() else p.name
    if not name.startswith("-"):
        return name
    # Best-effort decode: `--` → `/.`, single `-` → `/` (lossy for hyphens
    # that are part of directory names — caller should prefer cwd-from-log).
    encoded = name[1:]  # strip leading dash
    # Use a placeholder for the `--` (slash-dot) marker so we don't double-replace.
    SENTINEL = "\x00"
    encoded = encoded.replace("--", SENTINEL + ".")
    encoded = encoded.replace("-", "/")
    encoded = encoded.replace(SENTINEL, "/")
    return "/" + encoded


# Cache project-dir name → real cwd resolution to avoid re-reading log files
# during the inner loop.
_PROJECT_CWD_CACHE: dict[str, str] = {}


def resolve_project_cwd(proj_dir: Path) -> str:
    """Return the actual cwd path for a project dir, by reading the first
    available log event with a `cwd` field. Falls back to the lossy decoder
    if no log carries one.
    """
    cached = _PROJECT_CWD_CACHE.get(str(proj_dir))
    if cached is not None:
        return cached

    # Walk all jsonl files (top-level + nested subagents/) until we find a cwd.
    for jsonl in proj_dir.rglob("*.jsonl"):
        try:
            with jsonl.open() as f:
                for line in f:
                    try:
                        d = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    cwd = d.get("cwd")
                    if isinstance(cwd, str) and cwd:
                        _PROJECT_CWD_CACHE[str(proj_dir)] = cwd
                        return cwd
        except OSError:
            continue

    # No cwd found — fall back to lossy decode.
    decoded = project_name_from_path(proj_dir / "x")
    _PROJECT_CWD_CACHE[str(proj_dir)] = decoded
    return decoded


class ModelSlice:
    """Per-model token + accumulated cost slice within a bucket."""
    __slots__ = ("input", "output", "cache_5m", "cache_1h", "cache_read",
                 "web_search_requests", "events", "cost_accumulated")

    def __init__(self):
        self.input = 0
        self.output = 0
        self.cache_5m = 0
        self.cache_1h = 0
        self.cache_read = 0
        self.web_search_requests = 0
        self.events = 0
        # Cost is accumulated event-by-event (so per-event price overrides apply).
        self.cost_accumulated = 0.0

    def add(self, usage: dict, prices: dict, model_id: str | None = None):
        self.events += 1
        i = usage.get("input_tokens", 0) or 0
        o = usage.get("output_tokens", 0) or 0
        top_level_cache_creation = usage.get("cache_creation_input_tokens", 0) or 0
        cc = usage.get("cache_creation")
        if isinstance(cc, dict):
            c5 = cc.get("ephemeral_5m_input_tokens", 0) or 0
            c1h = cc.get("ephemeral_1h_input_tokens", 0) or 0
            # Older/edge Claude Code logs can carry a nonzero top-level
            # cache_creation_input_tokens value while the nested TTL split is
            # absent or zeroed. In that schema, the top-level field corresponded
            # to the standard 5-minute cache-write price.
            if top_level_cache_creation and (c5 + c1h) == 0:
                c5 = top_level_cache_creation
        else:
            c5 = top_level_cache_creation
            c1h = 0
        cr = usage.get("cache_read_input_tokens", 0) or 0
        server_tool_use = usage.get("server_tool_use") or {}
        if isinstance(server_tool_use, dict):
            web_search_requests = server_tool_use.get("web_search_requests", 0) or 0
        else:
            web_search_requests = 0
        self.input += i
        self.output += o
        self.cache_5m += c5
        self.cache_1h += c1h
        self.cache_read += cr
        self.web_search_requests += web_search_requests
        # Compute per-event cost using the model's prices.
        token_cost = (
            i * prices["input"] / 1_000_000
            + o * prices["output"] / 1_000_000
            + c5 * prices["cache_creation_5m"] / 1_000_000
            + c1h * prices["cache_creation_1h"] / 1_000_000
            + cr * prices["cache_read"] / 1_000_000
        )
        self.cost_accumulated += (
            token_cost * pricing_multiplier_for_usage(model_id, usage)
            + web_search_requests * WEB_SEARCH_USD_PER_REQUEST
        )

    @property
    def total_tokens(self) -> int:
        return (self.input + self.output + self.cache_5m + self.cache_1h + self.cache_read)

    @property
    def cost_usd(self) -> float:
        return round(self.cost_accumulated, 2)

    def to_dict(self) -> dict:
        return {
            "events": self.events,
            "input_tokens": self.input,
            "output_tokens": self.output,
            "cache_creation_5m_tokens": self.cache_5m,
            "cache_creation_1h_tokens": self.cache_1h,
            "cache_read_tokens": self.cache_read,
            "web_search_requests": self.web_search_requests,
            "total_tokens": self.total_tokens,
            "cost_usd": self.cost_usd,
        }


class UsageBucket:
    """Accumulates token + cost data, sliced by model family."""

    __slots__ = ("by_model", "first_ts", "last_ts")

    def __init__(self):
        self.by_model: dict[str, ModelSlice] = defaultdict(ModelSlice)
        self.first_ts: datetime | None = None
        self.last_ts: datetime | None = None

    def add(self, usage: dict, model_id: str | None,
             ts: datetime | None = None,
             override_prices: dict[str, float] | None = None):
        family = model_family(model_id)
        prices = prices_for_model(model_id, override_prices)
        self.by_model[family].add(usage, prices, model_id)
        if ts:
            if self.first_ts is None or ts < self.first_ts:
                self.first_ts = ts
            if self.last_ts is None or ts > self.last_ts:
                self.last_ts = ts

    @property
    def events(self) -> int:
        return sum(s.events for s in self.by_model.values())

    @property
    def total_tokens(self) -> int:
        return sum(s.total_tokens for s in self.by_model.values())

    @property
    def input(self) -> int:
        return sum(s.input for s in self.by_model.values())

    @property
    def output(self) -> int:
        return sum(s.output for s in self.by_model.values())

    @property
    def cache_5m(self) -> int:
        return sum(s.cache_5m for s in self.by_model.values())

    @property
    def cache_1h(self) -> int:
        return sum(s.cache_1h for s in self.by_model.values())

    @property
    def cache_read(self) -> int:
        return sum(s.cache_read for s in self.by_model.values())

    @property
    def web_search_requests(self) -> int:
        return sum(s.web_search_requests for s in self.by_model.values())

    @property
    def cost_usd(self) -> float:
        return round(sum(s.cost_accumulated for s in self.by_model.values()), 2)

    def to_dict(self) -> dict:
        return {
            "events": self.events,
            "input_tokens": self.input,
            "output_tokens": self.output,
            "cache_creation_5m_tokens": self.cache_5m,
            "cache_creation_1h_tokens": self.cache_1h,
            "cache_read_tokens": self.cache_read,
            "web_search_requests": self.web_search_requests,
            "total_tokens": self.total_tokens,
            "cost_usd": self.cost_usd,
            "by_model": {
                family: slice_.to_dict()
                for family, slice_ in sorted(self.by_model.items(),
                                              key=lambda x: -x[1].cost_accumulated)
            },
            "first_seen": self.first_ts.isoformat() if self.first_ts else None,
            "last_seen": self.last_ts.isoformat() if self.last_ts else None,
        }


def iter_usage_events(since_cutoff: datetime | None,
                       project_filter: str | None,
                       seen_request_ids: set[tuple] | None = None,
                       include_excluded: bool = False,
                       projects_dir: Path | None = None,
                       exclude_cwd_prefixes: list[str] | None = None):
    """Yield (timestamp, project, session_id, model_id, usage_dict, is_subagent) per event.

    Uses recursive glob so subagent logs at
    `<project>/<sessionId>/subagents/agent-XXX.jsonl` are included.

    Deduplicates by (requestId, message.id) — Claude Code stores multi-block
    responses (e.g., thinking + text) as separate events with the SAME usage
    block. The usage block represents the entire API call's billed tokens, so
    counting it once per request is correct; counting it per-event inflates
    by ~2x.

    Sessions whose cwd is under any configured exclude prefix are skipped by
    default. Pass `include_excluded=True` to include them.
    """
    if projects_dir is None:
        projects_dir = load_config().projects_dir
    if exclude_cwd_prefixes is None:
        exclude_cwd_prefixes = []

    if not projects_dir.is_dir():
        return

    if seen_request_ids is None:
        seen_request_ids = set()

    for proj_dir in projects_dir.iterdir():
        if not proj_dir.is_dir():
            continue
        # Resolve the real cwd from log events (avoids lossy decode of
        # `app-with-hyphen` → `app/with/hyphen` etc.).
        proj_name = resolve_project_cwd(proj_dir)
        if project_filter and project_filter not in proj_name:
            continue
        if not include_excluded and is_excluded_cwd(proj_name, exclude_cwd_prefixes):
            continue
        # Recursive: catches both top-level <session>.jsonl AND
        # <session>/subagents/agent-XXX.jsonl files.
        for session_file in proj_dir.rglob("*.jsonl"):
            # Detect subagent files: path includes `/subagents/`
            is_subagent = "subagents" in session_file.parts
            session_id = session_file.stem
            # Quick file-mtime cutoff: skip files older than `since_cutoff`.
            if since_cutoff:
                mtime = datetime.fromtimestamp(session_file.stat().st_mtime)
                if mtime < since_cutoff:
                    continue
            try:
                with session_file.open() as f:
                    for line in f:
                        try:
                            d = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        msg = d.get("message")
                        if not isinstance(msg, dict):
                            continue
                        usage = msg.get("usage")
                        if not isinstance(usage, dict):
                            continue

                        # Deduplicate: same API request stored as multiple
                        # events (thinking + text blocks of one response). The
                        # usage block is identical across them; count once.
                        rid = d.get("requestId")
                        mid = msg.get("id")
                        dedup_key = (rid, mid) if rid and mid else None
                        if dedup_key and dedup_key in seen_request_ids:
                            continue
                        if dedup_key:
                            seen_request_ids.add(dedup_key)

                        ts = parse_iso(d.get("timestamp") or msg.get("timestamp"))
                        if since_cutoff and ts and ts < since_cutoff:
                            continue
                        model_id = msg.get("model")
                        yield ts, proj_name, session_id, model_id, usage, is_subagent
            except OSError:
                continue


def include_excluded_for_args(args) -> bool:
    return bool(getattr(args, "include_excluded", False) or getattr(args, "include_cowork", False))


def runtime_exclude_prefixes(args, config: TokenomixConfig) -> list[str]:
    prefixes = list(config.exclude_cwd_prefixes)
    for p in getattr(args, "exclude_cwd_prefix", []) or []:
        prefixes.append(expand_prefix(p))
    return list(dict.fromkeys(prefixes))


def cmd_totals(args, override_prices: dict | None) -> dict:
    config = config_for_args(args)
    include_excluded = include_excluded_for_args(args)
    exclude_prefixes = runtime_exclude_prefixes(args, config)
    cutoff = compute_cutoff(args.since)
    bucket_main = UsageBucket()
    bucket_sub = UsageBucket()
    bucket_all = UsageBucket()
    for ts, proj, sid, model, usage, is_sub in iter_usage_events(
            cutoff, args.project,
            include_excluded=include_excluded,
            projects_dir=config.projects_dir,
            exclude_cwd_prefixes=exclude_prefixes):
        if is_sub:
            bucket_sub.add(usage, model, ts, override_prices)
        else:
            bucket_main.add(usage, model, ts, override_prices)
        bucket_all.add(usage, model, ts, override_prices)
    out = {
        "filter": {
            "since_days": args.since,
            "project": args.project,
            "cutoff": cutoff.isoformat() if cutoff else None,
            "projects_dir": str(config.projects_dir),
            "config_path": str(config.config_path) if config.config_path else None,
            "include_excluded": include_excluded,
            "exclude_cwd_prefixes": exclude_prefixes,
        },
        "model_pricing_tables": MODEL_PRICES,
        **bucket_all.to_dict(),
        "subagent_breakdown": {
            "main_session_events": bucket_main.events,
            "main_session_tokens": bucket_main.total_tokens,
            "main_session_cost_usd": bucket_main.cost_usd,
            "subagent_events": bucket_sub.events,
            "subagent_tokens": bucket_sub.total_tokens,
            "subagent_cost_usd": bucket_sub.cost_usd,
        },
    }
    return out


def cmd_daily(args, override_prices: dict | None) -> dict:
    config = config_for_args(args)
    include_excluded = include_excluded_for_args(args)
    exclude_prefixes = runtime_exclude_prefixes(args, config)
    cutoff = compute_cutoff(args.since)
    by_day: dict[str, UsageBucket] = defaultdict(UsageBucket)
    for ts, proj, sid, model, usage, is_sub in iter_usage_events(
            cutoff, args.project,
            include_excluded=include_excluded,
            projects_dir=config.projects_dir,
            exclude_cwd_prefixes=exclude_prefixes):
        if not ts:
            continue
        key = ts.strftime("%Y-%m-%d")
        by_day[key].add(usage, model, ts, override_prices)
    return {
        "filter": {"since_days": args.since, "project": args.project,
                   "projects_dir": str(config.projects_dir),
                   "include_excluded": include_excluded,
                   "exclude_cwd_prefixes": exclude_prefixes},
        "days": {k: by_day[k].to_dict() for k in sorted(by_day.keys())},
    }


def cmd_weekly(args, override_prices: dict | None) -> dict:
    config = config_for_args(args)
    include_excluded = include_excluded_for_args(args)
    exclude_prefixes = runtime_exclude_prefixes(args, config)
    cutoff = compute_cutoff(args.since)
    by_week: dict[str, UsageBucket] = defaultdict(UsageBucket)
    for ts, proj, sid, model, usage, is_sub in iter_usage_events(
            cutoff, args.project,
            include_excluded=include_excluded,
            projects_dir=config.projects_dir,
            exclude_cwd_prefixes=exclude_prefixes):
        if not ts:
            continue
        # ISO week: %G (year) + %V (week-of-year)
        key = ts.strftime("%G-W%V")
        by_week[key].add(usage, model, ts, override_prices)
    return {
        "filter": {"since_days": args.since, "project": args.project,
                   "projects_dir": str(config.projects_dir),
                   "include_excluded": include_excluded,
                   "exclude_cwd_prefixes": exclude_prefixes},
        "weeks": {k: by_week[k].to_dict() for k in sorted(by_week.keys())},
    }


def cmd_by_project(args, override_prices: dict | None) -> dict:
    config = config_for_args(args)
    include_excluded = include_excluded_for_args(args)
    exclude_prefixes = runtime_exclude_prefixes(args, config)
    cutoff = compute_cutoff(args.since)
    by_proj: dict[str, UsageBucket] = defaultdict(UsageBucket)
    for ts, proj, sid, model, usage, is_sub in iter_usage_events(
            cutoff, None,
            include_excluded=include_excluded,
            projects_dir=config.projects_dir,
            exclude_cwd_prefixes=exclude_prefixes):
        by_proj[proj].add(usage, model, ts, override_prices)
    sorted_projs = sorted(by_proj.items(), key=lambda x: -x[1].cost_usd)
    if args.top:
        sorted_projs = sorted_projs[: args.top]
    return {
        "filter": {"since_days": args.since,
                   "projects_dir": str(config.projects_dir),
                   "include_excluded": include_excluded,
                   "exclude_cwd_prefixes": exclude_prefixes},
        "projects": [
            {"project": proj, **bucket.to_dict()}
            for proj, bucket in sorted_projs
        ],
    }


def cmd_by_session(args, override_prices: dict | None) -> dict:
    config = config_for_args(args)
    include_excluded = include_excluded_for_args(args)
    exclude_prefixes = runtime_exclude_prefixes(args, config)
    cutoff = compute_cutoff(args.since)
    by_sess: dict[tuple, UsageBucket] = defaultdict(UsageBucket)
    for ts, proj, sid, model, usage, is_sub in iter_usage_events(
            cutoff, args.project,
            include_excluded=include_excluded,
            projects_dir=config.projects_dir,
            exclude_cwd_prefixes=exclude_prefixes):
        by_sess[(proj, sid)].add(usage, model, ts, override_prices)
    sorted_sess = sorted(by_sess.items(), key=lambda x: -x[1].cost_usd)
    if args.top:
        sorted_sess = sorted_sess[: args.top]
    return {
        "filter": {"since_days": args.since, "project": args.project,
                   "projects_dir": str(config.projects_dir),
                   "include_excluded": include_excluded,
                   "exclude_cwd_prefixes": exclude_prefixes},
        "sessions": [
            {"project": proj, "session_id": sid, **bucket.to_dict()}
            for (proj, sid), bucket in sorted_sess
        ],
    }


def cmd_by_model(args, override_prices: dict | None) -> dict:
    """Per-model-family breakdown: which models account for the spend?"""
    config = config_for_args(args)
    include_excluded = include_excluded_for_args(args)
    exclude_prefixes = runtime_exclude_prefixes(args, config)
    cutoff = compute_cutoff(args.since)
    bucket = UsageBucket()
    for ts, proj, sid, model, usage, is_sub in iter_usage_events(
            cutoff, args.project,
            include_excluded=include_excluded,
            projects_dir=config.projects_dir,
            exclude_cwd_prefixes=exclude_prefixes):
        bucket.add(usage, model, ts, override_prices)
    return {
        "filter": {"since_days": args.since, "project": args.project,
                   "projects_dir": str(config.projects_dir),
                   "include_excluded": include_excluded,
                   "exclude_cwd_prefixes": exclude_prefixes},
        "model_pricing_tables": MODEL_PRICES,
        "events": bucket.events,
        "total_tokens": bucket.total_tokens,
        "total_cost_usd": bucket.cost_usd,
        "by_model": bucket.to_dict()["by_model"],
    }


def render_markdown_report(totals: dict, daily: dict, weekly: dict,
                            by_project: dict, by_session: dict,
                            by_model_data: dict) -> str:
    lines = []
    lines.append("# Claude Code Real API Usage Report")
    lines.append("")
    lines.append(f"_Generated_: {datetime.now().isoformat(timespec='seconds')}")
    lines.append("")
    lines.append(f"_Source_: `~/.claude/projects/<project>/<session>.jsonl`")
    lines.append(f"_Pricing_: Anthropic public pricing — per-event model detection (Opus / Sonnet / Haiku)")
    lines.append("")

    f = totals["filter"]
    if f.get("since_days"):
        lines.append(f"_Window_: last {f['since_days']} days "
                     f"(cutoff: {f.get('cutoff','')})")
    else:
        lines.append("_Window_: all-time")
    if f.get("project"):
        lines.append(f"_Project filter_: {f['project']}")
    lines.append("")

    # ── Totals ──────────────────────────────────────────────────────────
    lines.append("## Totals")
    lines.append("")
    lines.append(f"- **Events** (deduped by requestId+message.id): {totals['events']:,}")
    lines.append(f"- **Total tokens**: {totals['total_tokens']:,}")
    lines.append(f"- **Total cost**: ${totals['cost_usd']:,.2f}")
    if totals.get("first_seen") and totals.get("last_seen"):
        first = totals["first_seen"][:10]
        last = totals["last_seen"][:10]
        lines.append(f"- **Span**: {first} → {last}")
    lines.append("")

    # ── Main vs subagent breakdown ──────────────────────────────────────
    sb = totals.get("subagent_breakdown") or {}
    if sb:
        lines.append("### Main session vs subagent breakdown")
        lines.append("")
        lines.append("| Source | Events | Tokens | Cost (USD) |")
        lines.append("|---|---:|---:|---:|")
        lines.append(
            f"| Main sessions (top-level conversations) | {sb['main_session_events']:,} "
            f"| {sb['main_session_tokens']:,} | ${sb['main_session_cost_usd']:,.2f} |"
        )
        lines.append(
            f"| Subagent dispatches (`<session>/subagents/`) | {sb['subagent_events']:,} "
            f"| {sb['subagent_tokens']:,} | ${sb['subagent_cost_usd']:,.2f} |"
        )
        total_cost = sb['main_session_cost_usd'] + sb['subagent_cost_usd']
        if total_cost > 0:
            sub_pct = round(100 * sb['subagent_cost_usd'] / total_cost, 1)
            lines.append(f"| **Subagent share of cost** | | | **{sub_pct}%** |")
        lines.append("")

    # ── By model ────────────────────────────────────────────────────────
    if totals.get("by_model"):
        lines.append("### By model family")
        lines.append("")
        lines.append("| Model | Events | Tokens | Cost (USD) | % of cost |")
        lines.append("|---|---:|---:|---:|---:|")
        total_cost = max(totals["cost_usd"], 0.01)
        for family, slice_ in totals["by_model"].items():
            pct = round(100 * slice_["cost_usd"] / total_cost, 1)
            lines.append(
                f"| {family} | {slice_['events']:,} | {slice_['total_tokens']:,} "
                f"| ${slice_['cost_usd']:,.2f} | {pct}% |"
            )
        lines.append("")

    # ── Token mix ───────────────────────────────────────────────────────
    lines.append("### Token mix (all models combined)")
    lines.append("")
    lines.append("| Type | Tokens | % of total |")
    lines.append("|---|---:|---:|")
    total_tok = max(totals["total_tokens"], 1)
    for label, key in [
        ("input", "input_tokens"),
        ("output", "output_tokens"),
        ("cache_creation_5m", "cache_creation_5m_tokens"),
        ("cache_creation_1h", "cache_creation_1h_tokens"),
        ("cache_read", "cache_read_tokens"),
    ]:
        tok = totals.get(key, 0)
        pct = round(100 * tok / total_tok, 1)
        lines.append(f"| {label} | {tok:,} | {pct}% |")
    lines.append("")

    if totals.get("web_search_requests", 0):
        lines.append("### Server tool usage")
        lines.append("")
        lines.append("| Tool | Requests | Cost (USD) |")
        lines.append("|---|---:|---:|")
        web_search_cost = totals["web_search_requests"] * WEB_SEARCH_USD_PER_REQUEST
        lines.append(
            f"| web_search | {totals['web_search_requests']:,} | ${web_search_cost:,.2f} |"
        )
        lines.append("")

    # ── Daily ───────────────────────────────────────────────────────────
    if daily.get("days"):
        lines.append("## Daily Usage")
        lines.append("")
        lines.append("| Date | Events | Tokens | Cost (USD) |")
        lines.append("|---|---:|---:|---:|")
        for date_str, v in daily["days"].items():
            lines.append(
                f"| {date_str} | {v['events']:,} | {v['total_tokens']:,} | ${v['cost_usd']:,.2f} |"
            )
        lines.append("")

    # ── Weekly ──────────────────────────────────────────────────────────
    if weekly.get("weeks"):
        lines.append("## Weekly Usage")
        lines.append("")
        lines.append("| Week | Events | Tokens | Cost (USD) |")
        lines.append("|---|---:|---:|---:|")
        for week_str, v in weekly["weeks"].items():
            lines.append(
                f"| {week_str} | {v['events']:,} | {v['total_tokens']:,} | ${v['cost_usd']:,.2f} |"
            )
        lines.append("")

    # ── By project ──────────────────────────────────────────────────────
    if by_project.get("projects"):
        lines.append("## Top Projects by Cost")
        lines.append("")
        lines.append("| Project | Events | Tokens | Cost (USD) |")
        lines.append("|---|---:|---:|---:|")
        for p in by_project["projects"]:
            lines.append(
                f"| `{p['project']}` | {p['events']:,} | "
                f"{p['total_tokens']:,} | ${p['cost_usd']:,.2f} |"
            )
        lines.append("")

    # ── Top sessions ────────────────────────────────────────────────────
    if by_session.get("sessions"):
        lines.append("## Top Sessions by Cost")
        lines.append("")
        lines.append("| Project | Session | Events | Tokens | Cost (USD) |")
        lines.append("|---|---|---:|---:|---:|")
        for s in by_session["sessions"]:
            lines.append(
                f"| `{s['project']}` | `{s['session_id'][:12]}…` "
                f"| {s['events']:,} | {s['total_tokens']:,} | ${s['cost_usd']:,.2f} |"
            )
        lines.append("")

    lines.append("---")
    lines.append("")
    lines.append("**Comparison with retro-tracked spend**: This report covers "
                 "ALL Claude Code usage (every conversation, every dispatch, "
                 "every direct interaction). The retro-tracked spend in "
                 "`retro-trends.py` covers only **structured orchestration "
                 "pipelines** that produced a retro file — typically <5% of "
                 "total usage.")
    return "\n".join(lines) + "\n"


def cmd_report(args, override_prices: dict | None) -> str:
    totals = cmd_totals(args, override_prices)
    daily = cmd_daily(args, override_prices)
    weekly = cmd_weekly(args, override_prices)
    include_excluded = include_excluded_for_args(args)
    exclude_cwd_prefix = getattr(args, "exclude_cwd_prefix", [])
    config = getattr(args, "config", None)
    projects_dir = getattr(args, "projects_dir", None)
    bp_args = argparse.Namespace(
        since=args.since, project=None, top=10, include_excluded=include_excluded,
        include_cowork=include_excluded, exclude_cwd_prefix=exclude_cwd_prefix,
        config=config, projects_dir=projects_dir,
    )
    by_project = cmd_by_project(bp_args, override_prices)
    bs_args = argparse.Namespace(
        since=args.since, project=args.project, top=10, include_excluded=include_excluded,
        include_cowork=include_excluded, exclude_cwd_prefix=exclude_cwd_prefix,
        config=config, projects_dir=projects_dir,
    )
    by_session = cmd_by_session(bs_args, override_prices)
    bm_args = argparse.Namespace(
        since=args.since, project=args.project, include_excluded=include_excluded,
        include_cowork=include_excluded, exclude_cwd_prefix=exclude_cwd_prefix,
        config=config, projects_dir=projects_dir,
    )
    by_model_data = cmd_by_model(bm_args, override_prices)
    return render_markdown_report(totals, daily, weekly, by_project, by_session, by_model_data)


def compute_cutoff(since_days: int | None) -> datetime | None:
    if since_days is None:
        return None
    return datetime.now() - timedelta(days=since_days)


def main():
    p = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = p.add_subparsers(dest="command", required=True)

    def add_pricing(parser):
        parser.add_argument("--price-input", type=float)
        parser.add_argument("--price-output", type=float)
        parser.add_argument("--price-cache-5m", type=float)
        parser.add_argument("--price-cache-1h", type=float)
        parser.add_argument("--price-cache-read", type=float)

    def add_runtime_config(parser):
        parser.add_argument("--config", help="optional tokenomix config JSON path")
        parser.add_argument("--projects-dir", dest="projects_dir", help="override Claude projects dir")
        parser.add_argument(
            "--exclude-cwd-prefix",
            action="append",
            default=[],
            help="exclude sessions whose resolved cwd is this path or a child path; repeatable",
        )
        parser.add_argument(
            "--include-excluded",
            action="store_true",
            help="include sessions under configured --exclude-cwd-prefix / config exclude_cwd_prefixes",
        )
        parser.add_argument(
            "--include-cowork",
            action="store_true",
            help=argparse.SUPPRESS,
        )

    for name, helpstr in [
        ("totals", "all-time totals (or windowed)"),
        ("daily", "per-day breakdown"),
        ("weekly", "per-ISO-week breakdown"),
        ("by-project", "per-project totals (top N)"),
        ("by-session", "per-session totals (top N)"),
        ("by-model", "per-model-family breakdown"),
    ]:
        sp = sub.add_parser(name.replace("-", "_"), help=helpstr)
        sp.add_argument("--since", type=int, default=None,
                        help="last N days (default: all-time)")
        sp.add_argument("--project", help="filter by project path substring")
        if name in ("by-project", "by-session"):
            sp.add_argument("--top", type=int, default=20)
        add_pricing(sp)
        add_runtime_config(sp)

    rp = sub.add_parser("report", help="comprehensive markdown report")
    rp.add_argument("--since", type=int, default=None)
    rp.add_argument("--project")
    rp.add_argument("--output")
    add_pricing(rp)
    add_runtime_config(rp)

    args = p.parse_args()

    # Build override-prices dict from CLI flags. None means use the per-model
    # default for that field; CLI overrides apply to ALL models uniformly.
    override_prices = {}
    for cli_attr, key in [
        ("price_input", "input"),
        ("price_output", "output"),
        ("price_cache_5m", "cache_creation_5m"),
        ("price_cache_1h", "cache_creation_1h"),
        ("price_cache_read", "cache_read"),
    ]:
        v = getattr(args, cli_attr, None)
        if v is not None:
            override_prices[key] = v

    try:
        config = config_for_args(args)
    except (FileNotFoundError, json.JSONDecodeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    if not config.projects_dir.is_dir():
        print(f"ERROR: {config.projects_dir} does not exist. No conversation logs to read.",
              file=sys.stderr)
        return 1

    op = override_prices if override_prices else None
    cmd = args.command
    if cmd == "totals":
        print(json.dumps(cmd_totals(args, op), indent=2))
    elif cmd == "daily":
        print(json.dumps(cmd_daily(args, op), indent=2))
    elif cmd == "weekly":
        print(json.dumps(cmd_weekly(args, op), indent=2))
    elif cmd == "by_project":
        print(json.dumps(cmd_by_project(args, op), indent=2))
    elif cmd == "by_session":
        print(json.dumps(cmd_by_session(args, op), indent=2))
    elif cmd == "by_model":
        print(json.dumps(cmd_by_model(args, op), indent=2))
    elif cmd == "report":
        report = cmd_report(args, op)
        if args.output:
            Path(args.output).write_text(report)
            print(f"Wrote report to {args.output}", file=sys.stderr)
        else:
            print(report)
    return 0


if __name__ == "__main__":
    sys.exit(main())
