#!/usr/bin/env python3
"""Aggregate retro spend, model trends, and forecast savings from improvements.

Complements `retro-history.py` (which produces trend statistics) by adding:
  - all-time and time-windowed cost rollups
  - per-subject and per-month breakdowns
  - forecasted savings from documented improvement infrastructure
    (REC-1 through REC-5 from the 2026-04-27 follow-up session)

Reads configured history files from `--history-path`, config, or environment.

Usage:
    retro-trends.py rollup       [--since YYYY-MM-DD] [--subject NAME] [--by month|subject|all]
    retro-trends.py timeline     [--since YYYY-MM-DD]  # one row per retro, chronological
    retro-trends.py forecast     [--baseline auto|<float-usd>] [--pipelines-per-month N]
    retro-trends.py report       [--output FILE]  # markdown report combining the above

Forecast pricing model (default; not the authoritative API billing model):
    Sonnet/balanced  $9.00 / 1M tokens (blended)
    Haiku/fast       $1.50 / 1M tokens (blended; ~5.5x cheaper than sonnet)
    Override via --price-balanced / --price-fast (USD per Mtok).
    Use `claude-usage.py` for exact per-event Claude API billing.

The forecast model is grounded in the prior 10 retros' recurrence rates:

    REC-1 (handoff schema validation):
      handoff_rejection_rate (historical) ≈ 0.60 (6 of 10 retros)
      avg cost per rejection ≈ 45,000 tokens
      expected savings per pipeline ≈ 0.60 × 45,000 = 27,000 tokens

    REC-2 (signing pre-flight):
      signing_failure_rate (historical) ≈ 0.30 (3 of 10 retros)
      avg cost per failure ≈ 32,000 tokens
      expected savings per pipeline ≈ 0.30 × 32,000 = 9,600 tokens

    REC-3 (plan validation extensions):
      truncation_rate ≈ 0.50 (5 of 10 retros), 50,000 tokens recovery
      path_typo_rate ≈ 0.20, 30,000 tokens recovery
      lockfile_race_rate ≈ 0.10, 30,000 tokens recovery
      expected savings per pipeline ≈ 31,000 tokens

    REC-4 (structural verifier replacement):
      deterministic per-pipeline savings: 213,000 tokens (4 verifier dispatches)

    REC-5 (model tier application):
      historical fraction of cost on roles eligible for downgrade ≈ 0.17
      effective savings = 0.17 × baseline_tokens × (1 - haiku_to_sonnet_price_ratio)
      with sonnet=$9, haiku=$1.50, ratio=0.167, effective fraction ≈ 0.14

Override forecast assumptions via --override key=value (e.g., --override
truncation_rate=0.30).

Exit codes:
    0  success
    1  file/data error
    2  invalid invocation
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from tokenomix_config import expand_path, load_config


DEFAULT_HISTORY_PATHS = []

# Override via CLI; defaults match the routing-config tier prices.
DEFAULT_PRICES_USD_PER_MTOK = {
    "balanced": 9.00,
    "fast": 1.50,
}

# Forecast model — recurrence rates from prior 10 retros (2026-04-11 through 04-22).
DEFAULT_FORECAST_PARAMS = {
    "handoff_rejection_rate": 0.60,
    "handoff_rejection_cost": 45_000,
    "signing_failure_rate": 0.30,
    "signing_failure_cost": 32_000,
    "truncation_rate": 0.50,
    "truncation_cost": 50_000,
    "path_typo_rate": 0.20,
    "path_typo_cost": 30_000,
    "lockfile_race_rate": 0.10,
    "lockfile_race_cost": 30_000,
    "structural_verifier_savings": 213_000,
    "model_tier_fraction": 0.14,
    "model_tier_eligible_fraction_of_baseline": 0.17,
}


def load_entries(history_paths: list[Path]) -> list[dict]:
    """Load and dedupe retro entries from all history files."""
    entries: list[dict] = []
    seen: set[str] = set()
    for p in history_paths:
        if not p.is_file():
            continue
        with p.open() as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    e = json.loads(line)
                except json.JSONDecodeError:
                    continue
                key = json.dumps(e, sort_keys=True)
                if key in seen:
                    continue
                seen.add(key)
                entries.append(e)
    return entries


def history_paths_for_args(args) -> list[Path]:
    cli_paths = getattr(args, "history_path", []) or []
    if cli_paths:
        return [expand_path(p) for p in cli_paths]

    env = os.environ.get("AGENT_RETRO_DIR")
    if env:
        # Backward-compatible override from the original script. When set, only
        # read this directory's canonical history file.
        return [expand_path(env) / "history.jsonl"]

    return load_config(getattr(args, "config", None)).retro_history_paths


def get_summary(entry: dict) -> dict:
    """Return the summary dict for either retro or improve entries."""
    if entry.get("type") == "improve":
        return entry
    return entry.get("summary", {}) or {}


def get_timestamp(entry: dict) -> str | None:
    return entry.get("timestamp") or get_summary(entry).get("timestamp")


# Subject aliases that should be folded together. Add new aliases here.
SUBJECT_ALIASES = {
    "orchestration": "orchestrator",
}


def get_subject(entry: dict) -> str:
    if entry.get("type") == "improve":
        raw = entry.get("subject") or "unknown"
    else:
        raw = get_summary(entry).get("subject") or "unknown"
    return SUBJECT_ALIASES.get(raw, raw)


def get_tokens(summary: dict) -> int:
    val = summary.get("total_tokens") or summary.get("total_tokens_consumed")
    if isinstance(val, (int, float)):
        return int(val)
    return 0


def get_cost(summary: dict) -> float:
    val = summary.get("total_cost_usd")
    if isinstance(val, (int, float)):
        return float(val)
    return 0.0


def get_wall_clock(summary: dict) -> float:
    val = summary.get("wall_clock_min")
    if isinstance(val, (int, float)):
        return float(val)
    return 0.0


def get_agents(summary: dict) -> int:
    val = summary.get("agents_spawned")
    if isinstance(val, (int, float)):
        return int(val)
    return 0


def parse_date(ts: str | None) -> datetime | None:
    if not ts:
        return None
    # Trim "Z" suffix or fractional weirdness like "21:48:57.6NZ"
    cleaned = ts.replace("Z", "").rstrip()
    # Handle nonstandard fractions seen in real data (e.g., ".6NZ" → strip ".6N")
    if "." in cleaned and cleaned.split(".")[-1].rstrip("0123456789"):
        # Trailing non-digit chars in fraction; strip everything after the dot.
        cleaned = cleaned.split(".")[0]
    try:
        return datetime.fromisoformat(cleaned)
    except ValueError:
        try:
            return datetime.strptime(cleaned, "%Y-%m-%dT%H:%M:%S")
        except ValueError:
            return None


def filter_by_since(entries: list[dict], since: str | None) -> list[dict]:
    if not since:
        return entries
    cutoff = parse_date(since)
    if not cutoff:
        return entries
    out = []
    for e in entries:
        ts = parse_date(get_timestamp(e))
        if ts is None or ts >= cutoff:
            out.append(e)
    return out


def filter_by_subject(entries: list[dict], subject: str | None) -> list[dict]:
    if not subject:
        return entries
    return [e for e in entries if get_subject(e).lower() == subject.lower()]


def cmd_rollup(args, entries: list[dict]) -> dict:
    entries = filter_by_subject(entries, args.subject)
    entries = filter_by_since(entries, args.since)

    # Filter to retros that actually have token data (improve entries are
    # informational; they don't have pipeline-level cost numbers).
    sized = [e for e in entries if get_tokens(get_summary(e)) > 0]

    total_tokens = sum(get_tokens(get_summary(e)) for e in sized)
    total_cost = sum(get_cost(get_summary(e)) for e in sized)
    total_wall = sum(get_wall_clock(get_summary(e)) for e in sized)
    total_agents = sum(get_agents(get_summary(e)) for e in sized)
    n = len(sized)

    rollup: dict[str, Any] = {
        "filter": {"since": args.since, "subject": args.subject},
        "total_retros_with_data": n,
        "total_retros_in_period": len(entries),
        "total_tokens": total_tokens,
        "total_cost_usd": round(total_cost, 2),
        "total_wall_clock_min": round(total_wall, 1),
        "total_agents_spawned": total_agents,
    }
    if n:
        rollup["averages"] = {
            "tokens_per_retro": round(total_tokens / n),
            "cost_per_retro_usd": round(total_cost / n, 2),
            "wall_clock_per_retro_min": round(total_wall / n, 1),
            "agents_per_retro": round(total_agents / n, 1),
        }

    if args.by == "month":
        by_month: dict[str, dict] = defaultdict(lambda: {
            "retros": 0, "tokens": 0, "cost_usd": 0.0, "wall_clock_min": 0.0,
        })
        for e in sized:
            ts = parse_date(get_timestamp(e))
            if not ts:
                continue
            key = ts.strftime("%Y-%m")
            s = get_summary(e)
            by_month[key]["retros"] += 1
            by_month[key]["tokens"] += get_tokens(s)
            by_month[key]["cost_usd"] += get_cost(s)
            by_month[key]["wall_clock_min"] += get_wall_clock(s)
        rollup["by_month"] = {
            month: {
                "retros": v["retros"],
                "tokens": v["tokens"],
                "cost_usd": round(v["cost_usd"], 2),
                "wall_clock_min": round(v["wall_clock_min"], 1),
            }
            for month, v in sorted(by_month.items())
        }

    elif args.by == "subject":
        by_subj: dict[str, dict] = defaultdict(lambda: {
            "retros": 0, "tokens": 0, "cost_usd": 0.0, "wall_clock_min": 0.0,
        })
        for e in sized:
            subj = get_subject(e)
            s = get_summary(e)
            by_subj[subj]["retros"] += 1
            by_subj[subj]["tokens"] += get_tokens(s)
            by_subj[subj]["cost_usd"] += get_cost(s)
            by_subj[subj]["wall_clock_min"] += get_wall_clock(s)
        rollup["by_subject"] = {
            subj: {
                "retros": v["retros"],
                "tokens": v["tokens"],
                "cost_usd": round(v["cost_usd"], 2),
                "wall_clock_min": round(v["wall_clock_min"], 1),
            }
            for subj, v in sorted(by_subj.items(), key=lambda x: -x[1]["cost_usd"])
        }

    return rollup


def cmd_timeline(args, entries: list[dict]) -> dict:
    entries = filter_by_subject(entries, args.subject)
    entries = filter_by_since(entries, args.since)

    rows = []
    for e in entries:
        s = get_summary(e)
        tokens = get_tokens(s)
        if tokens == 0 and e.get("type") != "improve":
            continue  # skip retros with no metrics
        ts = get_timestamp(e)
        rows.append({
            "timestamp": ts,
            "type": e.get("type", "retro"),
            "subject": get_subject(e),
            "session_id": s.get("session_id"),
            "tokens": tokens,
            "cost_usd": get_cost(s),
            "wall_clock_min": get_wall_clock(s),
            "agents": get_agents(s),
            "findings_total": s.get("findings_total"),
            "verdict": s.get("verdict"),
            "version": s.get("version"),
        })
    # Sort chronologically (oldest first)
    rows.sort(key=lambda r: r["timestamp"] or "")
    return {
        "filter": {"since": args.since, "subject": args.subject},
        "row_count": len(rows),
        "timeline": rows,
    }


def compute_baseline(entries: list[dict], explicit: float | None) -> tuple[float, str]:
    if explicit is not None and explicit > 0:
        return explicit, "explicit"
    sized = [e for e in entries if get_tokens(get_summary(e)) > 0]
    if not sized:
        return 0.0, "no-data"
    costs = [get_cost(get_summary(e)) for e in sized if get_cost(get_summary(e)) > 0]
    if costs:
        baseline = sum(costs) / len(costs)
        return round(baseline, 2), f"avg-of-{len(costs)}-retros"
    # Fall back to tokens converted at balanced price
    tokens = [get_tokens(get_summary(e)) for e in sized]
    avg_tokens = sum(tokens) / len(tokens)
    baseline = avg_tokens * DEFAULT_PRICES_USD_PER_MTOK["balanced"] / 1_000_000
    return round(baseline, 2), f"computed-from-tokens ({len(tokens)} retros)"


def cmd_forecast(args, entries: list[dict]) -> dict:
    """Project per-pipeline savings under the post-2026-04-27-followup state."""
    baseline_cost, basis = compute_baseline(entries, args.baseline_value)

    # Get average tokens for token-based estimates
    sized = [e for e in entries if get_tokens(get_summary(e)) > 0]
    if sized:
        baseline_tokens = sum(get_tokens(get_summary(e)) for e in sized) / len(sized)
    else:
        baseline_tokens = 0
    baseline_tokens = round(baseline_tokens)

    # Apply overrides
    params = dict(DEFAULT_FORECAST_PARAMS)
    if args.overrides:
        for ov in args.overrides:
            if "=" in ov:
                k, v = ov.split("=", 1)
                if k in params:
                    try:
                        params[k] = float(v)
                    except ValueError:
                        pass

    # Per-pipeline savings (in tokens)
    rec1_tokens = params["handoff_rejection_rate"] * params["handoff_rejection_cost"]
    rec2_tokens = params["signing_failure_rate"] * params["signing_failure_cost"]
    rec3_truncation_tokens = params["truncation_rate"] * params["truncation_cost"]
    rec3_path_tokens = params["path_typo_rate"] * params["path_typo_cost"]
    rec3_lockfile_tokens = params["lockfile_race_rate"] * params["lockfile_race_cost"]
    rec3_tokens = rec3_truncation_tokens + rec3_path_tokens + rec3_lockfile_tokens
    rec4_tokens = params["structural_verifier_savings"]
    rec5_tokens = baseline_tokens * params["model_tier_fraction"]

    # Convert to USD using the balanced (sonnet) price as the marginal saved tier
    price_balanced = args.price_balanced or DEFAULT_PRICES_USD_PER_MTOK["balanced"]
    price_fast = args.price_fast or DEFAULT_PRICES_USD_PER_MTOK["fast"]

    def to_usd(tokens: float) -> float:
        return round(tokens * price_balanced / 1_000_000, 2)

    rec1_cost = to_usd(rec1_tokens)
    rec2_cost = to_usd(rec2_tokens)
    rec3_cost = to_usd(rec3_tokens)
    rec4_cost = to_usd(rec4_tokens)
    # REC-5 specifically swaps tier (saves price_balanced - price_fast per Mtok on
    # the eligible fraction). Recompute using that swap rather than full price.
    rec5_eligible_tokens = baseline_tokens * params["model_tier_eligible_fraction_of_baseline"]
    rec5_cost = round(rec5_eligible_tokens * (price_balanced - price_fast) / 1_000_000, 2)

    total_token_savings = rec1_tokens + rec2_tokens + rec3_tokens + rec4_tokens + rec5_eligible_tokens
    total_cost_savings = rec1_cost + rec2_cost + rec3_cost + rec4_cost + rec5_cost

    # Projected per-pipeline cost
    projected_cost = max(0, baseline_cost - total_cost_savings)
    pct_reduction = round(100 * total_cost_savings / baseline_cost, 1) if baseline_cost > 0 else 0.0

    pipelines_per_month = args.pipelines_per_month
    monthly_savings = round(total_cost_savings * pipelines_per_month, 2)
    annual_savings = round(monthly_savings * 12, 2)

    return {
        "baseline": {
            "method": basis,
            "avg_cost_usd_per_retro": baseline_cost,
            "avg_tokens_per_retro": baseline_tokens,
            "based_on_n_retros": len(sized),
        },
        "params": params,
        "prices_usd_per_mtok": {
            "balanced": price_balanced,
            "fast": price_fast,
        },
        "per_pipeline_savings": {
            "REC-1_handoff_validation": {
                "tokens_saved": int(rec1_tokens),
                "cost_saved_usd": rec1_cost,
                "rationale": f"handoff_rejection_rate={params['handoff_rejection_rate']:.0%} × {params['handoff_rejection_cost']:,} tokens recovery",
            },
            "REC-2_signing_preflight": {
                "tokens_saved": int(rec2_tokens),
                "cost_saved_usd": rec2_cost,
                "rationale": f"signing_failure_rate={params['signing_failure_rate']:.0%} × {params['signing_failure_cost']:,} tokens recovery",
            },
            "REC-3_plan_validation": {
                "tokens_saved": int(rec3_tokens),
                "cost_saved_usd": rec3_cost,
                "breakdown": {
                    "truncation_avoided": int(rec3_truncation_tokens),
                    "path_typo_avoided": int(rec3_path_tokens),
                    "lockfile_race_avoided": int(rec3_lockfile_tokens),
                },
                "rationale": "weighted sum of 3 plan-level error classes by historical recurrence",
            },
            "REC-4_structural_verifier_replacement": {
                "tokens_saved": int(rec4_tokens),
                "cost_saved_usd": rec4_cost,
                "rationale": f"deterministic 4 × ~53K tokens per pipeline replaced with bash script",
            },
            "REC-5_model_tier_application": {
                "tokens_saved": int(rec5_eligible_tokens),
                "cost_saved_usd": rec5_cost,
                "rationale": f"{params['model_tier_eligible_fraction_of_baseline']:.0%} of baseline tokens shifted from balanced (${price_balanced}/Mtok) to fast (${price_fast}/Mtok)",
            },
        },
        "totals": {
            "total_tokens_saved_per_pipeline": int(total_token_savings),
            "total_cost_saved_per_pipeline_usd": round(total_cost_savings, 2),
            "pct_reduction": pct_reduction,
            "projected_cost_per_pipeline_usd": round(projected_cost, 2),
        },
        "scaled": {
            "pipelines_per_month_assumption": pipelines_per_month,
            "monthly_savings_usd": monthly_savings,
            "annual_savings_usd": annual_savings,
        },
    }


def render_markdown_report(rollup: dict, timeline: dict, forecast: dict) -> str:
    lines = []
    lines.append("# Retro Spend & Forecast Report")
    lines.append("")
    lines.append(f"_Generated_: {datetime.now().isoformat(timespec='seconds')}")
    lines.append("")

    # ── All-Time Rollup ─────────────────────────────────────────────────
    lines.append("## All-Time Rollup")
    lines.append("")
    lines.append(f"- **Retros with cost data**: {rollup['total_retros_with_data']}")
    lines.append(f"- **Total tokens consumed**: {rollup['total_tokens']:,}")
    lines.append(f"- **Total cost**: ${rollup['total_cost_usd']:.2f}")
    lines.append(f"- **Total wall-clock**: {rollup['total_wall_clock_min']:.1f} min ({rollup['total_wall_clock_min']/60:.1f} hr)")
    lines.append(f"- **Total agents spawned**: {rollup['total_agents_spawned']:,}")
    if "averages" in rollup:
        a = rollup["averages"]
        lines.append("")
        lines.append("### Averages")
        lines.append(f"- Tokens per retro: {a['tokens_per_retro']:,}")
        lines.append(f"- Cost per retro: ${a['cost_per_retro_usd']:.2f}")
        lines.append(f"- Wall-clock per retro: {a['wall_clock_per_retro_min']:.1f} min")
        lines.append(f"- Agents per retro: {a['agents_per_retro']}")
    lines.append("")

    # ── By Month ────────────────────────────────────────────────────────
    if "by_month" in rollup:
        lines.append("## Monthly Breakdown")
        lines.append("")
        lines.append("| Month | Retros | Tokens | Cost (USD) | Wall-clock (min) |")
        lines.append("|---|---:|---:|---:|---:|")
        for month, v in rollup["by_month"].items():
            lines.append(
                f"| {month} | {v['retros']} | {v['tokens']:,} "
                f"| ${v['cost_usd']:.2f} | {v['wall_clock_min']:.1f} |"
            )
        lines.append("")

    # ── Per-subject ────────────────────────────────────────────────────
    if "by_subject" in rollup:
        lines.append("## Per-Subject Breakdown")
        lines.append("")
        lines.append("| Subject | Retros | Tokens | Cost (USD) | Wall-clock (min) |")
        lines.append("|---|---:|---:|---:|---:|")
        for subj, v in rollup["by_subject"].items():
            lines.append(
                f"| {subj} | {v['retros']} | {v['tokens']:,} "
                f"| ${v['cost_usd']:.2f} | {v['wall_clock_min']:.1f} |"
            )
        lines.append("")

    # ── Timeline ────────────────────────────────────────────────────────
    lines.append("## Chronological Timeline")
    lines.append("")
    if timeline["row_count"]:
        lines.append("| Date | Subject | Session | Tokens | Cost | Agents | Findings | Verdict |")
        lines.append("|---|---|---|---:|---:|---:|---:|---|")
        for row in timeline["timeline"]:
            ts = row["timestamp"] or ""
            date = ts.split("T")[0] if ts else ""
            lines.append(
                f"| {date} | {row['subject']} | "
                f"{row['session_id'] or ''} | {row['tokens']:,} | "
                f"${row['cost_usd']:.2f} | {row['agents']} | "
                f"{row['findings_total'] or '-'} | {row['verdict'] or '-'} |"
            )
        lines.append("")

    # ── Forecast ────────────────────────────────────────────────────────
    lines.append("## Forecast: Per-Pipeline Savings (Post-2026-04-27 Follow-up)")
    lines.append("")
    bl = forecast["baseline"]
    tot = forecast["totals"]
    lines.append(f"**Baseline** (computed via `{bl['method']}`):")
    lines.append(f"- avg cost per pipeline: ${bl['avg_cost_usd_per_retro']:.2f}")
    lines.append(f"- avg tokens per pipeline: {bl['avg_tokens_per_retro']:,}")
    lines.append(f"- based on {bl['based_on_n_retros']} retros with cost data")
    lines.append("")
    lines.append("### Per-pipeline savings by REC")
    lines.append("")
    lines.append("| REC | Tokens saved | Cost saved (USD) | Rationale |")
    lines.append("|---|---:|---:|---|")
    for rec_id, data in forecast["per_pipeline_savings"].items():
        rationale = data["rationale"].replace("|", "\\|")
        lines.append(
            f"| {rec_id} | {data['tokens_saved']:,} | "
            f"${data['cost_saved_usd']:.2f} | {rationale} |"
        )
    lines.append(
        f"| **TOTAL** | **{tot['total_tokens_saved_per_pipeline']:,}** | "
        f"**${tot['total_cost_saved_per_pipeline_usd']:.2f}** | "
        f"**{tot['pct_reduction']}% reduction** |"
    )
    lines.append("")
    lines.append(f"### Projected per-pipeline cost: ${tot['projected_cost_per_pipeline_usd']:.2f}")
    lines.append("")
    lines.append("### Scaled forecast")
    sc = forecast["scaled"]
    lines.append(f"- Assuming **{sc['pipelines_per_month_assumption']} pipelines/month**:")
    lines.append(f"  - Monthly savings: **${sc['monthly_savings_usd']:.2f}**")
    lines.append(f"  - Annual savings: **${sc['annual_savings_usd']:.2f}**")
    lines.append("")
    lines.append("### Forecast assumptions")
    lines.append("")
    lines.append("| Parameter | Value | Source |")
    lines.append("|---|---:|---|")
    p = forecast["params"]
    lines.append(f"| handoff_rejection_rate | {p['handoff_rejection_rate']} | 6 of 10 retros had handoff rejections |")
    lines.append(f"| handoff_rejection_cost (tokens) | {int(p['handoff_rejection_cost']):,} | avg of W-3/W-4/W-5 from 04-22 21:04 |")
    lines.append(f"| signing_failure_rate | {p['signing_failure_rate']} | 3 of 10 retros (04-21, 04-22 phase4, 04-22 21:04) |")
    lines.append(f"| signing_failure_cost (tokens) | {int(p['signing_failure_cost']):,} | release-engineer-6a-attempt1 = 39,996 tokens |")
    lines.append(f"| truncation_rate | {p['truncation_rate']} | 5 of 10 retros |")
    lines.append(f"| truncation_cost (tokens) | {int(p['truncation_cost']):,} | per-event recovery cost from retros |")
    lines.append(f"| path_typo_rate | {p['path_typo_rate']} | 2 of 10 retros |")
    lines.append(f"| path_typo_cost (tokens) | {int(p['path_typo_cost']):,} | typical replan + revise loop |")
    lines.append(f"| lockfile_race_rate | {p['lockfile_race_rate']} | 1 of 10 retros (W2 phase5) |")
    lines.append(f"| lockfile_race_cost (tokens) | {int(p['lockfile_race_cost']):,} | manual lockfile surgery + re-run |")
    lines.append(f"| structural_verifier_savings (tokens) | {int(p['structural_verifier_savings']):,} | per 04-21 R-003 (4 × 53K) |")
    lines.append(f"| model_tier_eligible_fraction | {p['model_tier_eligible_fraction_of_baseline']} | per 04-21 retro 3.8 |")
    lines.append("")
    lines.append("Override any value at runtime: `--override truncation_rate=0.30`")
    return "\n".join(lines) + "\n"


def cmd_report(args, entries: list[dict]) -> str:
    """Render a comprehensive markdown report combining rollup, timeline, forecast."""
    rollup_args = argparse.Namespace(
        since=args.since, subject=args.subject, by="month",
    )
    rollup = cmd_rollup(rollup_args, entries)
    rollup["by_subject"] = cmd_rollup(
        argparse.Namespace(since=args.since, subject=args.subject, by="subject"),
        entries,
    ).get("by_subject", {})

    timeline_args = argparse.Namespace(since=args.since, subject=args.subject)
    timeline = cmd_timeline(timeline_args, entries)

    forecast_args = argparse.Namespace(
        baseline_value=args.baseline_value,
        pipelines_per_month=args.pipelines_per_month,
        overrides=args.overrides,
        price_balanced=args.price_balanced,
        price_fast=args.price_fast,
    )
    forecast = cmd_forecast(forecast_args, entries)

    return render_markdown_report(rollup, timeline, forecast)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--config", help="optional tokenomix config JSON path")
    p.add_argument(
        "--history-path",
        action="append",
        default=[],
        help="retro history.jsonl path; repeatable. Overrides config/env/default discovery.",
    )
    sub = p.add_subparsers(dest="command", required=True)

    def add_runtime_config(parser):
        parser.add_argument("--config", help="optional tokenomix config JSON path")
        parser.add_argument(
            "--history-path",
            action="append",
            default=[],
            help="retro history.jsonl path; repeatable. Overrides config/env/default discovery.",
        )

    rp = sub.add_parser("rollup", help="aggregate cost across a window")
    add_runtime_config(rp)
    rp.add_argument("--since", help="ISO date (YYYY-MM-DD) cutoff")
    rp.add_argument("--subject", help="filter by retro subject")
    rp.add_argument("--by", choices=["month", "subject", "all"], default="all")

    tp = sub.add_parser("timeline", help="chronological per-retro timeline")
    add_runtime_config(tp)
    tp.add_argument("--since", help="ISO date (YYYY-MM-DD) cutoff")
    tp.add_argument("--subject", help="filter by retro subject")

    fp = sub.add_parser("forecast", help="project savings from improvements")
    add_runtime_config(fp)
    fp.add_argument("--baseline", dest="baseline_value", type=float, default=None,
                    help="explicit baseline cost USD per pipeline (default: avg of historical retros)")
    fp.add_argument("--pipelines-per-month", type=int, default=20,
                    help="for monthly/annual scaling (default: 20)")
    fp.add_argument("--override", dest="overrides", action="append", default=[],
                    help="override forecast param (e.g., --override truncation_rate=0.30)")
    fp.add_argument("--price-balanced", type=float, default=None,
                    help="USD per Mtok for balanced/sonnet (default: 9.00)")
    fp.add_argument("--price-fast", type=float, default=None,
                    help="USD per Mtok for fast/haiku (default: 1.50)")

    rep = sub.add_parser("report", help="comprehensive markdown report (rollup + timeline + forecast)")
    add_runtime_config(rep)
    rep.add_argument("--since", help="ISO date (YYYY-MM-DD) cutoff")
    rep.add_argument("--subject", help="filter by retro subject")
    rep.add_argument("--baseline", dest="baseline_value", type=float, default=None)
    rep.add_argument("--pipelines-per-month", type=int, default=20)
    rep.add_argument("--override", dest="overrides", action="append", default=[])
    rep.add_argument("--price-balanced", type=float, default=None)
    rep.add_argument("--price-fast", type=float, default=None)
    rep.add_argument("--output", help="write report to file")

    args = p.parse_args()

    try:
        history_paths = history_paths_for_args(args)
    except (FileNotFoundError, json.JSONDecodeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    entries = load_entries(history_paths)
    if not entries:
        print(json.dumps({"error": "no history entries found",
                          "paths_checked": [str(p) for p in history_paths]}, indent=2))
        return 1

    if args.command == "rollup":
        result = cmd_rollup(args, entries)
        print(json.dumps(result, indent=2))
    elif args.command == "timeline":
        result = cmd_timeline(args, entries)
        print(json.dumps(result, indent=2))
    elif args.command == "forecast":
        result = cmd_forecast(args, entries)
        print(json.dumps(result, indent=2))
    elif args.command == "report":
        report = cmd_report(args, entries)
        if args.output:
            Path(args.output).write_text(report)
            print(f"Wrote report to {args.output}", file=sys.stderr)
        else:
            print(report)
    return 0


if __name__ == "__main__":
    sys.exit(main())
