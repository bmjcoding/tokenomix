#!/usr/bin/env python3
"""Generate a self-contained HTML dashboard for Claude Code usage.

Aggregates data from `claude-usage.py` (real API usage from conversation logs)
and `retro-trends.py` (retro-tracked spend + forecast) and renders a single
HTML file with Chart.js visualizations. Open the HTML file directly in a
browser — no server required.

Usage:
    usage-dashboard.py [--output FILE]
    usage-dashboard.py --open    # also opens the file in default browser

Output: a self-contained HTML file with embedded JSON data and CDN-loaded
Chart.js. Re-run to refresh.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path

# Resolve sibling scripts and project output dir relative to this file.
# Layout:
#   ~/.claude/tokenomix/
#     ├── bin/
#     │   ├── claude-usage.py       <- this file's siblings
#     │   ├── retro-trends.py
#     │   └── usage-dashboard.py    <- this file
#     └── output/
#         └── usage-dashboard.html  <- DEFAULT_OUTPUT
SCRIPTS_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPTS_DIR.parent
DEFAULT_OUTPUT = PROJECT_ROOT / "output" / "usage-dashboard.html"


def run_script(script_name: str, args: list[str]) -> dict:
    """Run a script and parse its JSON output."""
    cmd = ["python3", str(SCRIPTS_DIR / script_name)] + args
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0 and not proc.stdout.strip():
        return {"error": proc.stderr.strip(), "command": " ".join(cmd)}
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as e:
        return {"error": f"could not parse JSON: {e}", "raw": proc.stdout[:500]}


def collect_data(
    include_excluded: bool = False,
    config: str | None = None,
    projects_dir: str | None = None,
    exclude_cwd_prefixes: list[str] | None = None,
) -> dict:
    """Run all the data-collection scripts and assemble the dashboard data.

    Exclusion prefixes are configured through tokenomix config, env, or
    explicit `--exclude-cwd-prefix` flags. They are skipped by default and can
    be included with `--include-excluded`.
    """
    usage_extra: list[str] = []
    retro_extra: list[str] = []
    if config:
        usage_extra += ["--config", config]
        retro_extra += ["--config", config]
    if projects_dir:
        usage_extra += ["--projects-dir", projects_dir]
    for prefix in exclude_cwd_prefixes or []:
        usage_extra += ["--exclude-cwd-prefix", prefix]
    if include_excluded:
        usage_extra.append("--include-excluded")

    data = {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "include_excluded": include_excluded,
    }

    print("Collecting all-time usage…", file=sys.stderr)
    data["totals_all"] = run_script("claude-usage.py", ["totals", *usage_extra])

    print("Collecting last 30 days…", file=sys.stderr)
    data["totals_30d"] = run_script("claude-usage.py", ["totals", "--since", "30", *usage_extra])

    print("Collecting last 5 days…", file=sys.stderr)
    data["totals_5d"] = run_script("claude-usage.py", ["totals", "--since", "5", *usage_extra])

    print("Collecting daily breakdown…", file=sys.stderr)
    data["daily"] = run_script("claude-usage.py", ["daily", *usage_extra])

    print("Collecting weekly breakdown…", file=sys.stderr)
    data["weekly"] = run_script("claude-usage.py", ["weekly", *usage_extra])

    print("Collecting per-project breakdown…", file=sys.stderr)
    data["by_project"] = run_script("claude-usage.py", ["by_project", "--top", "20", *usage_extra])

    print("Collecting top sessions…", file=sys.stderr)
    data["by_session"] = run_script("claude-usage.py", ["by_session", "--top", "15", *usage_extra])

    print("Collecting per-model breakdown…", file=sys.stderr)
    data["by_model"] = run_script("claude-usage.py", ["by_model", *usage_extra])

    print("Collecting retro-tracked spend…", file=sys.stderr)
    data["retro_rollup"] = run_script("retro-trends.py", ["rollup", "--by", "subject", *retro_extra])
    data["retro_timeline"] = run_script("retro-trends.py", ["timeline", *retro_extra])
    data["retro_forecast"] = run_script(
        "retro-trends.py", ["forecast", "--pipelines-per-month", "20", *retro_extra]
    )

    return data


HTML_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claude Code Usage Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
  /* Color system uses organization-dashboard density and OKLCH tokens.
     Monochromatic discipline: 1 chromatic accent (primary blue) + status semantics.
     Anti-busy compliant (max 3 non-gray colors visible). */
  :root {
    /* Page surfaces (Radix gray steps 1-5, dark mode) */
    --bg-page:        oklch(0.09 0 0);          /* page background */
    --bg-surface:     oklch(0.16 0 0);          /* card bg (gray-900) */
    --bg-elevated:    oklch(0.20 0 0);          /* hover/active surfaces */
    --bg-codeblock:   oklch(0.13 0 0);          /* inline code background */

    /* Borders (Radix gray steps 6-8) */
    --border-subtle:  oklch(0.24 0 0);          /* default borders (gray-800) */
    --border:         oklch(0.32 0 0);          /* emphasized borders */

    /* Text (Radix gray steps 11-12 + secondary/muted) */
    --text:           oklch(0.97 0 0);          /* primary text (near-white) */
    --text-secondary: oklch(0.77 0 0);          /* secondary text (labels) */
    --text-muted:     oklch(0.55 0 0);          /* deemphasized text */
    --text-soft:      oklch(0.43 0 0);          /* faintest readable */

    /* Accent: primary blue hue */
    --primary:        oklch(0.58 0.12 255);     /* main accent */
    --primary-hover:  oklch(0.65 0.13 255);     /* hover state */
    --primary-soft:   oklch(0.58 0.12 255 / 0.15);  /* 15% fill for chart areas */

    /* Status colors — used ONLY for semantic state, never decoratively.
       All within design-authority gamut: chroma <= 0.20, lightness 0.50-0.85. */
    --success:        oklch(0.72 0.17 145);
    --warning:        oklch(0.75 0.15 85);

    /* Spacing & shape — platform density mode for dashboard */
    --radius-card:    0.75rem;                   /* rounded-xl */
    --radius-pill:    0.375rem;                  /* rounded-md (badges) */
  }

  * { box-sizing: border-box; }
  html, body { background: var(--bg-page); }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    color: var(--text);
    line-height: 1.5;
    font-feature-settings: "tnum";
    font-variant-numeric: tabular-nums;
  }
  .container {
    max-width: 1440px;
    margin: 0 auto;
    padding: 24px 32px;
  }

  /* ── Header ────────────────────────────────────────────────────────── */
  header {
    margin-bottom: 24px;
    padding-bottom: 16px;
    border-bottom: 1px solid var(--border-subtle);
  }
  h1 {
    margin: 0 0 4px;
    font-size: 1.5rem;
    font-weight: 700;
    letter-spacing: -0.025em;
    color: var(--text);
  }
  header .subtitle {
    color: var(--text-muted);
    font-size: 0.8125rem;
  }

  /* ── Layout grids — platform density (gap-3 = 12px, gap-4 = 16px) ──── */
  .grid { display: grid; gap: 12px; }
  .grid-cards {
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    margin-bottom: 16px;
  }
  .grid-charts {
    grid-template-columns: 2fr 1fr;
    margin-bottom: 16px;
  }
  .grid-tables {
    grid-template-columns: 1fr 1fr;
    margin-bottom: 16px;
  }
  @media (max-width: 1024px) {
    .grid-charts, .grid-tables { grid-template-columns: 1fr; }
  }

  /* ── Cards & panels ─────────────────────────────────────────────────── */
  /* Dense dashboard cards and panels:
     - 16px radius for primary cards, 12px for inner surfaces
     - 20px padding for cards and panels
     - subtle dark borders */
  .card, .panel {
    background: var(--bg-surface);
    border: 1px solid var(--border-subtle);
    border-radius: 1rem;
    padding: 20px;                  /* p-5 */
  }

  /* KPI card structure:
       <div class="flex items-start justify-between gap-3">
         <div class="flex-1">
           label (xs uppercase tracking-wide)
           value (2xl bold tracking-tight)
           context (xs muted)
         </div>
         <icon class="h-4 w-4 text-gray-400 shrink-0">
       </div> */
  .kpi {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }
  .kpi-body { flex: 1; min-width: 0; }
  .kpi-icon {
    flex-shrink: 0;
    width: 16px;
    height: 16px;
    margin-top: 2px;
    color: var(--text-muted);
    stroke: currentColor;
    fill: none;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .label {
    color: var(--text-muted);
    font-size: 0.6875rem;            /* text-xs (11px) */
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: 500;
    margin-bottom: 4px;
    line-height: 1.4;
  }
  .value {
    font-size: 1.5rem;                /* text-2xl */
    font-weight: 700;
    letter-spacing: -0.025em;
    line-height: 1.15;
    color: var(--text);
  }
  .value.accent { color: var(--primary); }
  .value-secondary {
    margin-top: 4px;
    color: var(--text-muted);
    font-size: 0.75rem;
    line-height: 1.4;
  }

  /* Mini progress bar inside KPI cards (matches CompletenessBar.tsx).
     Used to show subagent share, daily trend, etc. */
  .progress-track {
    margin-top: 10px;
    height: 4px;                      /* h-1 */
    background: var(--bg-elevated);
    border-radius: 9999px;
    overflow: hidden;
  }
  .progress-fill {
    height: 100%;
    background: var(--primary);
    border-radius: 9999px;
    transition: width 300ms ease;
  }

  /* Panel headers — icon + uppercase label, like HealthTab section headings */
  .panel-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 12px;
  }
  .panel-icon {
    width: 14px;
    height: 14px;
    color: var(--text-muted);
    stroke: currentColor;
    fill: none;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
    flex-shrink: 0;
  }
  .panel h2 {
    margin: 0;
    font-size: 0.6875rem;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: 500;
    line-height: 1.4;
  }
  .panel p {
    color: var(--text-muted);
    font-size: 0.8125rem;
    margin-top: 0;
  }

  /* ── Tables ─────────────────────────────────────────────────────────── */
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.8125rem;          /* text-[13px] */
  }
  th, td {
    padding: 6px 10px;
    text-align: left;
    line-height: 1.4;
  }
  thead th {
    color: var(--text-muted);
    font-size: 0.6875rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: 500;
    border-bottom: 1px solid var(--border-subtle);
  }
  tbody tr {
    border-bottom: 1px solid var(--bg-elevated);
    transition: background-color 120ms ease;
  }
  tbody tr:hover { background: var(--bg-elevated); }
  tbody tr:last-child { border-bottom: 0; }
  .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
    font-feature-settings: "tnum";
  }
  .truncate {
    max-width: 280px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* ── Chart containers ───────────────────────────────────────────────── */
  .chart-container { position: relative; height: 240px; }
  .chart-container.tall { height: 320px; }

  /* Cards are not interactive here, so the hover effect is very subtle. */
  .card { transition: border-color 150ms ease, background-color 150ms ease; }
  .card:hover {
    border-color: var(--border);
    background: oklch(0.17 0 0);  /* one step lighter than --bg-surface */
  }

  /* ── Inline elements ────────────────────────────────────────────────── */
  code {
    background: var(--bg-codeblock);
    border: 1px solid var(--border-subtle);
    padding: 1px 6px;
    border-radius: var(--radius-pill);
    font-size: 0.75rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    color: var(--text-secondary);
  }

  .footer {
    margin-top: 24px;
    padding-top: 16px;
    border-top: 1px solid var(--border-subtle);
    color: var(--text-soft);
    font-size: 0.75rem;
  }
  .footer code { color: var(--text-muted); }

  .forecast-row td { font-variant-numeric: tabular-nums; }
  .forecast-row.total-row td {
    font-weight: 600;
    border-top: 2px solid var(--border);
    padding-top: 10px;
  }
  .pos { color: var(--success); }
  .neg { color: var(--warning); }

  /* Help text used inline above forecast/retro tables */
  .panel-help {
    color: var(--text-muted);
    font-size: 0.8125rem;
    margin: -4px 0 12px;
  }
  .forecast-summary { margin-top: 12px; margin-bottom: 0; }

  /* Section spacing — uniform 16px between major panels (platform density). */
  .section { margin-bottom: 16px; }

  /* Error banner — semantic warning color, gamut-compliant */
  .error-banner {
    background: oklch(0.30 0.10 25);   /* dark red, low chroma per gamut */
    color: var(--text);
    padding: 12px 16px;
    margin: 0 0 16px;
    border-radius: var(--radius-card);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 0.8125rem;
  }
</style>
</head>
<body>
<div class="container">
  <header>
    <h1>Claude Code Usage Dashboard</h1>
    <div class="subtitle">
      Real API usage from conversation logs (deduped + subagents included).
      Generated: <span id="generated-at"></span>.
    </div>
  </header>

  <!-- KPI Cards: label / value / context / mini-bar -->
  <div class="grid grid-cards">
    <div class="card">
      <div class="kpi">
        <div class="kpi-body">
          <p class="label">All-time cost</p>
          <p class="value accent" id="kpi-alltime-cost">—</p>
          <p class="value-secondary" id="kpi-alltime-tokens">—</p>
        </div>
        <!-- DollarSign icon (Lucide) -->
        <svg class="kpi-icon" viewBox="0 0 24 24" aria-hidden="true">
          <line x1="12" y1="2" x2="12" y2="22"></line>
          <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path>
        </svg>
      </div>
      <div class="progress-track" aria-hidden="true">
        <div class="progress-fill" id="kpi-alltime-bar"></div>
      </div>
    </div>

    <div class="card">
      <div class="kpi">
        <div class="kpi-body">
          <p class="label">Last 30 days</p>
          <p class="value" id="kpi-30d-cost">—</p>
          <p class="value-secondary" id="kpi-30d-tokens">—</p>
        </div>
        <!-- Calendar icon -->
        <svg class="kpi-icon" viewBox="0 0 24 24" aria-hidden="true">
          <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
          <line x1="16" y1="2" x2="16" y2="6"></line>
          <line x1="8" y1="2" x2="8" y2="6"></line>
          <line x1="3" y1="10" x2="21" y2="10"></line>
        </svg>
      </div>
      <div class="progress-track" aria-hidden="true">
        <div class="progress-fill" id="kpi-30d-bar"></div>
      </div>
    </div>

    <div class="card">
      <div class="kpi">
        <div class="kpi-body">
          <p class="label">Last 5 days</p>
          <p class="value" id="kpi-5d-cost">—</p>
          <p class="value-secondary" id="kpi-5d-tokens">—</p>
        </div>
        <!-- Clock icon -->
        <svg class="kpi-icon" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="10"></circle>
          <polyline points="12 6 12 12 16 14"></polyline>
        </svg>
      </div>
      <div class="progress-track" aria-hidden="true">
        <div class="progress-fill" id="kpi-5d-bar"></div>
      </div>
    </div>

    <div class="card">
      <div class="kpi">
        <div class="kpi-body">
          <p class="label">Subagent share</p>
          <p class="value" id="kpi-subagent-pct">—</p>
          <p class="value-secondary" id="kpi-subagent-cost">—</p>
        </div>
        <!-- Users icon -->
        <svg class="kpi-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path>
          <circle cx="9" cy="7" r="4"></circle>
          <path d="M22 21v-2a4 4 0 0 0-3-3.87"></path>
          <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
        </svg>
      </div>
      <div class="progress-track" aria-hidden="true">
        <div class="progress-fill" id="kpi-subagent-bar"></div>
      </div>
    </div>
  </div>

  <!-- Daily / Per-model -->
  <div class="grid grid-charts">
    <div class="panel">
      <div class="panel-header">
        <!-- BarChart icon -->
        <svg class="panel-icon" viewBox="0 0 24 24" aria-hidden="true">
          <line x1="12" y1="20" x2="12" y2="10"></line>
          <line x1="18" y1="20" x2="18" y2="4"></line>
          <line x1="6" y1="20" x2="6" y2="16"></line>
        </svg>
        <h2>Daily cost</h2>
      </div>
      <div class="chart-container tall"><canvas id="chart-daily"></canvas></div>
    </div>
    <div class="panel">
      <div class="panel-header">
        <!-- PieChart icon -->
        <svg class="panel-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M21.21 15.89A10 10 0 1 1 8 2.83"></path>
          <path d="M22 12A10 10 0 0 0 12 2v10z"></path>
        </svg>
        <h2>By model family</h2>
      </div>
      <div class="chart-container tall"><canvas id="chart-models"></canvas></div>
    </div>
  </div>

  <!-- Token mix / Weekly -->
  <div class="grid grid-charts">
    <div class="panel">
      <div class="panel-header">
        <!-- TrendingUp icon -->
        <svg class="panel-icon" viewBox="0 0 24 24" aria-hidden="true">
          <polyline points="22 7 13.5 15.5 8.5 10.5 2 17"></polyline>
          <polyline points="16 7 22 7 22 13"></polyline>
        </svg>
        <h2>Weekly cost</h2>
      </div>
      <div class="chart-container"><canvas id="chart-weekly"></canvas></div>
    </div>
    <div class="panel">
      <div class="panel-header">
        <!-- Layers icon -->
        <svg class="panel-icon" viewBox="0 0 24 24" aria-hidden="true">
          <polygon points="12 2 2 7 12 12 22 7 12 2"></polygon>
          <polyline points="2 17 12 22 22 17"></polyline>
          <polyline points="2 12 12 17 22 12"></polyline>
        </svg>
        <h2>Token mix (% of total)</h2>
      </div>
      <div class="chart-container"><canvas id="chart-tokenmix"></canvas></div>
    </div>
  </div>

  <!-- Tables: Top projects + Top sessions -->
  <div class="grid grid-tables">
    <div class="panel">
      <div class="panel-header">
        <!-- Folder icon -->
        <svg class="panel-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
        </svg>
        <h2>Top projects (by cost, all-time)</h2>
      </div>
      <table>
        <thead>
          <tr>
            <th>Project</th>
            <th class="num">Events</th>
            <th class="num">Tokens</th>
            <th class="num">Cost</th>
          </tr>
        </thead>
        <tbody id="tbody-projects"></tbody>
      </table>
    </div>
    <div class="panel">
      <div class="panel-header">
        <!-- MessageSquare icon -->
        <svg class="panel-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
        </svg>
        <h2>Top sessions (by cost, all-time)</h2>
      </div>
      <table>
        <thead>
          <tr>
            <th>Project</th>
            <th>Session</th>
            <th class="num">Tokens</th>
            <th class="num">Cost</th>
          </tr>
        </thead>
        <tbody id="tbody-sessions"></tbody>
      </table>
    </div>
  </div>

  <!-- Main vs Subagent breakdown -->
  <div class="panel section">
    <div class="panel-header">
      <!-- GitBranch icon (subagent dispatch) -->
      <svg class="panel-icon" viewBox="0 0 24 24" aria-hidden="true">
        <line x1="6" y1="3" x2="6" y2="15"></line>
        <circle cx="18" cy="6" r="3"></circle>
        <circle cx="6" cy="18" r="3"></circle>
        <path d="M18 9a9 9 0 0 1-9 9"></path>
      </svg>
      <h2>Main sessions vs subagent dispatches (all-time)</h2>
    </div>
    <div class="chart-container"><canvas id="chart-main-vs-sub"></canvas></div>
  </div>

  <!-- Retro-tracked + Forecast -->
  <div class="panel section">
    <div class="panel-header">
      <!-- Sparkles / Activity icon -->
      <svg class="panel-icon" viewBox="0 0 24 24" aria-hidden="true">
        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline>
      </svg>
      <h2>Forecast: per-pipeline savings (REC-1..REC-5)</h2>
    </div>
    <p class="panel-help">
      Forecast applies to formal orchestration pipelines (subset of total usage).
      Baseline = average cost per retro from history. Per-pipeline savings model based on prior-10-retro recurrence rates.
    </p>
    <table>
      <thead>
        <tr>
          <th>Recommendation</th>
          <th class="num">Tokens saved</th>
          <th class="num">Cost saved</th>
          <th>Rationale</th>
        </tr>
      </thead>
      <tbody id="tbody-forecast"></tbody>
    </table>
    <div class="panel-help forecast-summary" id="forecast-summary"></div>
  </div>

  <!-- Retro spend table -->
  <div class="panel section">
    <div class="panel-header">
      <!-- BookOpen icon -->
      <svg class="panel-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"></path>
        <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"></path>
      </svg>
      <h2>Retro-tracked spend by subject</h2>
    </div>
    <p class="panel-help">
      Note: retro-tracked spend captures only formal orchestration sessions that produced a retro file.
      Typically &lt;2% of total API usage. See top tables for the full picture.
    </p>
    <table>
      <thead>
        <tr>
          <th>Subject</th>
          <th class="num">Retros</th>
          <th class="num">Tokens</th>
          <th class="num">Cost</th>
          <th class="num">Wall-clock (min)</th>
        </tr>
      </thead>
      <tbody id="tbody-retro-subjects"></tbody>
    </table>
  </div>

  <div class="footer">
    Generated by <code>~/.claude/tokenomix/bin/usage-dashboard.py</code>.
    Re-run to refresh. Data sources: <code>claude-usage.py</code> (real API)
    and <code>retro-trends.py</code> (retro-tracked).
    Real API spend uses Anthropic public pricing with per-event model detection;
    retro forecasts use their documented blended assumptions.
  </div>
</div>

<script>
const DATA = __DATA_PLACEHOLDER__;

// ── Chart.js global config ──────────────────────────────────────────────
// Resolve OKLCH tokens from CSS variables so the chart palette stays in sync
// with the design system. This is the single source of truth — adding/changing
// a token in :root automatically propagates to charts.
const CSS = getComputedStyle(document.documentElement);
const cssVar = (name) => CSS.getPropertyValue(name).trim();

Chart.defaults.color = cssVar('--text-muted');
Chart.defaults.borderColor = cssVar('--border-subtle');
Chart.defaults.font.family = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
Chart.defaults.font.size = 11;
Chart.defaults.scale.grid.color = cssVar('--border-subtle');

// Monochromatic-with-accent palette (per design-authority/charts.md):
//   primary series = accent (primary blue)
//   secondary series = gray-400 (--text-secondary, oklch(0.77 0 0))
//   tertiary series = gray-500 (--text-muted, oklch(0.55 0 0))
// Status colors used ONLY when semantic (success/warning).
const PALETTE = {
  primary:    cssVar('--primary'),
  primarySoft:cssVar('--primary-soft'),
  secondary:  cssVar('--text-secondary'),
  tertiary:   cssVar('--text-muted'),
  surface:    cssVar('--bg-surface'),
  border:     cssVar('--border-subtle'),
  success:    cssVar('--success'),
  warning:    cssVar('--warning'),
};

// ── Helpers ─────────────────────────────────────────────────────────────
function fmtCost(n) {
  if (n == null) return '—';
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtTokens(n) {
  if (n == null) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toLocaleString('en-US');
}
function fmtNum(n) {
  if (n == null) return '—';
  return n.toLocaleString('en-US');
}

// ── KPI cards ──────────────────────────────────────────────────────────
function renderKPIs() {
  const all = DATA.totals_all || {};
  const t30 = DATA.totals_30d || {};
  const t5 = DATA.totals_5d || {};

  document.getElementById('generated-at').textContent = DATA.generated_at;
  document.getElementById('kpi-alltime-cost').textContent = fmtCost(all.cost_usd);
  document.getElementById('kpi-alltime-tokens').textContent =
    fmtTokens(all.total_tokens) + ' tokens · ' + fmtNum(all.events) + ' events';
  document.getElementById('kpi-30d-cost').textContent = fmtCost(t30.cost_usd);
  document.getElementById('kpi-30d-tokens').textContent =
    fmtTokens(t30.total_tokens) + ' tokens';
  document.getElementById('kpi-5d-cost').textContent = fmtCost(t5.cost_usd);
  document.getElementById('kpi-5d-tokens').textContent =
    fmtTokens(t5.total_tokens) + ' tokens';

  const sb = all.subagent_breakdown || {};
  const totalCost = (sb.main_session_cost_usd || 0) + (sb.subagent_cost_usd || 0);
  const subPct = totalCost > 0 ? (100 * sb.subagent_cost_usd / totalCost) : 0;
  document.getElementById('kpi-subagent-pct').textContent = subPct.toFixed(1) + '%';
  document.getElementById('kpi-subagent-cost').textContent =
    fmtCost(sb.subagent_cost_usd) + ' (' + fmtNum(sb.subagent_events) + ' events)';

  // Progress-bar fills — show each window as a fraction of all-time.
  // The all-time bar always shows 100% as a visual reference / max.
  // The 30d card fills relative to all-time (most recent activity proportion);
  // the 5d card fills relative to 30d (recency intensity).
  // The subagent card mirrors the % share value.
  const allCost = all.cost_usd || 1;
  document.getElementById('kpi-alltime-bar').style.width = '100%';
  document.getElementById('kpi-30d-bar').style.width =
    Math.min(100, 100 * (t30.cost_usd || 0) / allCost) + '%';
  document.getElementById('kpi-5d-bar').style.width =
    Math.min(100, 100 * (t5.cost_usd || 0) / Math.max(t30.cost_usd || 1, 1)) + '%';
  document.getElementById('kpi-subagent-bar').style.width =
    Math.min(100, subPct) + '%';
}

// ── Daily chart ────────────────────────────────────────────────────────
// Reusable Chart.js options object so all charts share consistent styling.
function commonOptions(extra = {}) {
  return Object.assign({
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    layout: { padding: { top: 8, right: 8, bottom: 0, left: 0 } },
    plugins: {
      legend: {
        position: 'top',
        align: 'end',
        labels: {
          boxWidth: 8,
          boxHeight: 8,
          usePointStyle: true,
          pointStyle: 'circle',
          padding: 12,
          font: { size: 11 },
          color: cssVar('--text-secondary'),
        },
      },
      tooltip: {
        backgroundColor: cssVar('--bg-elevated'),
        titleColor: cssVar('--text'),
        bodyColor: cssVar('--text-secondary'),
        borderColor: cssVar('--border-subtle'),
        borderWidth: 1,
        padding: 10,
        cornerRadius: 6,
        displayColors: true,
        boxWidth: 8,
        boxHeight: 8,
        usePointStyle: true,
      },
    },
  }, extra);
}

function renderDaily() {
  const days = (DATA.daily || {}).days || {};
  const labels = Object.keys(days).sort();
  // Pretty short date labels: "Apr 13" instead of "2026-04-13"
  const shortLabels = labels.map(d => {
    const [y, m, day] = d.split('-');
    const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${monthNames[parseInt(m,10)-1]} ${parseInt(day,10)}`;
  });
  const costs = labels.map(d => days[d].cost_usd);
  const tokens = labels.map(d => days[d].total_tokens / 1e6);

  new Chart(document.getElementById('chart-daily'), {
    type: 'bar',
    data: {
      labels: shortLabels,
      datasets: [
        {
          label: 'Cost (USD)',
          data: costs,
          backgroundColor: PALETTE.primary,
          borderRadius: 3,
          borderSkipped: false,
          yAxisID: 'y',
          order: 2,
          barPercentage: 0.7,
          categoryPercentage: 0.8,
        },
        {
          label: 'Tokens',
          data: tokens,
          type: 'line',
          borderColor: PALETTE.secondary,
          backgroundColor: PALETTE.primarySoft,
          borderWidth: 1.5,
          pointRadius: 0,
          pointHoverRadius: 4,
          pointHoverBackgroundColor: PALETTE.secondary,
          pointHoverBorderColor: PALETTE.surface,
          pointHoverBorderWidth: 2,
          fill: false,
          yAxisID: 'y1',
          tension: 0.4,
          order: 1,
        },
      ],
    },
    options: commonOptions({
      scales: {
        x: {
          ticks: { autoSkip: true, maxTicksLimit: 10, color: cssVar('--text-muted'), font: { size: 10 } },
          grid: { display: false },
          border: { color: cssVar('--border-subtle') },
        },
        y: {
          position: 'left',
          ticks: { callback: v => '$' + v, color: cssVar('--text-muted'), font: { size: 10 } },
          grid: { color: cssVar('--border-subtle'), drawTicks: false },
          border: { display: false },
        },
        y1: {
          position: 'right',
          grid: { drawOnChartArea: false },
          ticks: { callback: v => v + 'M', color: cssVar('--text-muted'), font: { size: 10 } },
          border: { display: false },
        },
      },
      plugins: Object.assign(commonOptions().plugins, {
        tooltip: Object.assign(commonOptions().plugins.tooltip, {
          callbacks: {
            label: (ctx) => {
              if (ctx.dataset.label === 'Cost (USD)') return ' Cost: ' + fmtCost(ctx.raw);
              return ' Tokens: ' + ctx.raw.toFixed(1) + 'M';
            },
          },
        }),
      }),
    }),
  });
}

// ── Weekly chart ───────────────────────────────────────────────────────
function renderWeekly() {
  const weeks = (DATA.weekly || {}).weeks || {};
  const labels = Object.keys(weeks).sort();
  // Compact week labels: "W14" instead of "2026-W14"
  const shortLabels = labels.map(w => {
    const m = w.match(/W(\\d+)/);
    return m ? `Week ${m[1]}` : w;
  });
  const costs = labels.map(w => weeks[w].cost_usd);

  new Chart(document.getElementById('chart-weekly'), {
    type: 'bar',
    data: {
      labels: shortLabels,
      datasets: [{
        label: 'Cost (USD)',
        data: costs,
        backgroundColor: PALETTE.primary,
        borderRadius: 3,
        borderSkipped: false,
        barPercentage: 0.7,
        categoryPercentage: 0.8,
      }],
    },
    options: commonOptions({
      plugins: Object.assign(commonOptions().plugins, {
        legend: { display: false },
        tooltip: Object.assign(commonOptions().plugins.tooltip, {
          callbacks: { label: (ctx) => ' ' + fmtCost(ctx.raw) },
        }),
      }),
      scales: {
        x: {
          ticks: { color: cssVar('--text-muted'), font: { size: 10 } },
          grid: { display: false },
          border: { color: cssVar('--border-subtle') },
        },
        y: {
          ticks: { callback: v => '$' + v, color: cssVar('--text-muted'), font: { size: 10 } },
          grid: { color: cssVar('--border-subtle'), drawTicks: false },
          border: { display: false },
        },
      },
    }),
  });
}

// ── Per-model donut ────────────────────────────────────────────────────
function renderModels() {
  const all = DATA.totals_all || {};
  const byModel = all.by_model || {};
  const families = Object.keys(byModel);
  const costs = families.map(f => byModel[f].cost_usd);
  // Per design-authority charts.md: primary=accent, secondary=gray-400, tertiary=gray-300.
  // Most expensive family gets the accent; rest descend through grays.
  const ranked = families.map(f => ({ family: f, cost: byModel[f].cost_usd }))
    .sort((a, b) => b.cost - a.cost);
  const tierColors = [PALETTE.primary, PALETTE.secondary, PALETTE.tertiary];
  const colorMap = {};
  ranked.forEach((entry, i) => { colorMap[entry.family] = tierColors[i] || PALETTE.tertiary; });
  const colors = families.map(f => colorMap[f]);

  // Center-label plugin: writes the dominant family + cost in the doughnut hole
  const centerLabel = {
    id: 'centerLabel',
    afterDraw(chart, _args, opts) {
      if (chart.config.type !== 'doughnut') return;
      const { ctx, chartArea } = chart;
      const cx = (chartArea.left + chartArea.right) / 2;
      const cy = (chartArea.top + chartArea.bottom) / 2;
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = cssVar('--text');
      ctx.font = '600 18px -apple-system, BlinkMacSystemFont, system-ui';
      ctx.fillText(opts.value || '', cx, cy - 8);
      ctx.fillStyle = cssVar('--text-muted');
      ctx.font = '500 10px -apple-system, BlinkMacSystemFont, system-ui';
      ctx.fillText((opts.label || '').toUpperCase(), cx, cy + 10);
      ctx.restore();
    },
  };

  const totalCost = costs.reduce((a, b) => a + b, 0);
  const dominantFam = ranked[0] ? ranked[0].family : '';
  const dominantPct = totalCost > 0 ? Math.round(100 * (ranked[0]?.cost || 0) / totalCost) : 0;

  new Chart(document.getElementById('chart-models'), {
    type: 'doughnut',
    plugins: [centerLabel],
    data: {
      labels: families.map(f => f.charAt(0).toUpperCase() + f.slice(1)),
      datasets: [{
        data: costs,
        backgroundColor: colors,
        borderColor: PALETTE.surface,
        borderWidth: 3,
        hoverBorderColor: PALETTE.surface,
        hoverOffset: 4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '68%',
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            boxWidth: 8,
            boxHeight: 8,
            usePointStyle: true,
            pointStyle: 'circle',
            padding: 14,
            font: { size: 11 },
            color: cssVar('--text-secondary'),
          },
        },
        tooltip: Object.assign(commonOptions().plugins.tooltip, {
          callbacks: {
            label: (ctx) => {
              const fam = families[ctx.dataIndex];
              const slc = byModel[fam];
              const searches = slc.web_search_requests
                ? ` · ${fmtNum(slc.web_search_requests)} searches`
                : '';
              return ` ${fmtCost(slc.cost_usd)} · ${fmtNum(slc.events)} events${searches}`;
            },
          },
        }),
        centerLabel: { value: dominantPct + '%', label: dominantFam },
      },
    },
  });
}

// ── Token mix donut ────────────────────────────────────────────────────
function renderTokenMix() {
  const all = DATA.totals_all || {};
  const total = all.total_tokens || 1;
  // Token-mix coloring uses a single accent + gray ramp (no green/cyan/amber
  // mix — that would breach anti-busy). The dominant slice (cache_read,
  // ~96%) gets the accent so the eye reads it as "this is what costs money";
  // smaller slices shade through gray ramp.
  const data = [
    { label: 'Cache read',         value: all.cache_read_tokens || 0,         color: PALETTE.primary },
    { label: 'Cache 1h create',    value: all.cache_creation_1h_tokens || 0,  color: PALETTE.secondary },
    { label: 'Output',             value: all.output_tokens || 0,             color: PALETTE.tertiary },
    { label: 'Cache 5m create',    value: all.cache_creation_5m_tokens || 0,  color: cssVar('--text-soft') },
    { label: 'Input',              value: all.input_tokens || 0,              color: cssVar('--border') },
  ];

  // Reuse the centerLabel plugin defined in renderModels().
  // Find the dominant slice for the center text.
  const dominant = data.reduce((max, d) => d.value > max.value ? d : max, data[0]);
  const totalAll = total;
  const dominantPct = Math.round(100 * (dominant?.value || 0) / Math.max(totalAll, 1));

  const centerLabel = {
    id: 'centerLabelMix',
    afterDraw(chart, _args, opts) {
      if (chart.config.type !== 'doughnut') return;
      const { ctx, chartArea } = chart;
      const cx = (chartArea.left + chartArea.right) / 2;
      const cy = (chartArea.top + chartArea.bottom) / 2;
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = cssVar('--text');
      ctx.font = '600 18px -apple-system, BlinkMacSystemFont, system-ui';
      ctx.fillText(opts.value || '', cx, cy - 8);
      ctx.fillStyle = cssVar('--text-muted');
      ctx.font = '500 10px -apple-system, BlinkMacSystemFont, system-ui';
      ctx.fillText((opts.label || '').toUpperCase(), cx, cy + 10);
      ctx.restore();
    },
  };

  new Chart(document.getElementById('chart-tokenmix'), {
    type: 'doughnut',
    plugins: [centerLabel],
    data: {
      labels: data.map(d => d.label),
      datasets: [{
        data: data.map(d => d.value),
        backgroundColor: data.map(d => d.color),
        borderColor: PALETTE.surface,
        borderWidth: 3,
        hoverOffset: 4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '68%',
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            boxWidth: 8,
            boxHeight: 8,
            usePointStyle: true,
            pointStyle: 'circle',
            padding: 12,
            font: { size: 10 },
            color: cssVar('--text-secondary'),
          },
        },
        tooltip: Object.assign(commonOptions().plugins.tooltip, {
          callbacks: {
            label: (ctx) => {
              const tok = ctx.raw;
              const pct = (100 * tok / totalAll).toFixed(1);
              return ` ${fmtTokens(tok)} · ${pct}%`;
            },
          },
        }),
        centerLabelMix: { value: dominantPct + '%', label: dominant?.label || '' },
      },
    },
  });
}

// ── Main vs Subagent — 100% stacked bars (clearer than absolute) ───────
function renderMainVsSub() {
  const sb = (DATA.totals_all || {}).subagent_breakdown || {};
  const main = {
    events: sb.main_session_events || 0,
    tokens: (sb.main_session_tokens || 0),
    cost:   sb.main_session_cost_usd || 0,
  };
  const sub = {
    events: sb.subagent_events || 0,
    tokens: (sb.subagent_tokens || 0),
    cost:   sb.subagent_cost_usd || 0,
  };
  // Convert to percentages for a 100%-stacked view (more readable than absolute
  // when one dimension is events and another is dollars).
  const totals = {
    events: main.events + sub.events || 1,
    tokens: main.tokens + sub.tokens || 1,
    cost:   main.cost + sub.cost || 1,
  };
  const mainPct = [
    100 * main.events / totals.events,
    100 * main.tokens / totals.tokens,
    100 * main.cost / totals.cost,
  ];
  const subPct = mainPct.map(p => 100 - p);
  // Carry the absolute values for tooltip use
  const absoluteMain = [main.events, main.tokens, main.cost];
  const absoluteSub  = [sub.events, sub.tokens, sub.cost];
  const dimFmt = [fmtNum, fmtTokens, fmtCost];
  const dimLabels = ['Events', 'Tokens', 'Cost'];

  new Chart(document.getElementById('chart-main-vs-sub'), {
    type: 'bar',
    data: {
      labels: dimLabels,
      datasets: [
        {
          label: 'Main session',
          data: mainPct,
          backgroundColor: PALETTE.primary,
          borderRadius: 3,
          borderSkipped: false,
          stack: 'a',
        },
        {
          label: 'Subagent',
          data: subPct,
          backgroundColor: PALETTE.secondary,
          borderRadius: 3,
          borderSkipped: false,
          stack: 'a',
        },
      ],
    },
    options: commonOptions({
      indexAxis: 'y',
      scales: {
        x: {
          stacked: true,
          beginAtZero: true,
          max: 100,
          ticks: { callback: v => v + '%', color: cssVar('--text-muted'), font: { size: 10 } },
          grid: { color: cssVar('--border-subtle'), drawTicks: false },
          border: { display: false },
        },
        y: {
          stacked: true,
          ticks: { color: cssVar('--text-secondary'), font: { size: 11 } },
          grid: { display: false },
          border: { color: cssVar('--border-subtle') },
        },
      },
      plugins: Object.assign(commonOptions().plugins, {
        legend: Object.assign(commonOptions().plugins.legend, {
          position: 'bottom',
          align: 'center',
        }),
        tooltip: Object.assign(commonOptions().plugins.tooltip, {
          callbacks: {
            label: (ctx) => {
              const isMain = ctx.dataset.label === 'Main session';
              const arr = isMain ? absoluteMain : absoluteSub;
              const fmt = dimFmt[ctx.dataIndex];
              return ` ${ctx.dataset.label}: ${fmt(arr[ctx.dataIndex])} (${ctx.raw.toFixed(1)}%)`;
            },
          },
        }),
      }),
    }),
  });
}

// ── Top projects table ─────────────────────────────────────────────────
function renderProjects() {
  const tbody = document.getElementById('tbody-projects');
  const list = (DATA.by_project || {}).projects || [];
  tbody.innerHTML = list.map(p => `
    <tr>
      <td class="truncate" title="${p.project}">${p.project}</td>
      <td class="num">${fmtNum(p.events)}</td>
      <td class="num">${fmtTokens(p.total_tokens)}</td>
      <td class="num">${fmtCost(p.cost_usd)}</td>
    </tr>
  `).join('');
}

// ── Top sessions table ─────────────────────────────────────────────────
function renderSessions() {
  const tbody = document.getElementById('tbody-sessions');
  const list = (DATA.by_session || {}).sessions || [];
  tbody.innerHTML = list.map(s => {
    const projShort = s.project.split('/').slice(-2).join('/');
    const sidShort = (s.session_id || '').slice(0, 8);
    return `
      <tr>
        <td class="truncate" title="${s.project}">${projShort}</td>
        <td><code>${sidShort}…</code></td>
        <td class="num">${fmtTokens(s.total_tokens)}</td>
        <td class="num">${fmtCost(s.cost_usd)}</td>
      </tr>
    `;
  }).join('');
}

// ── Forecast table ─────────────────────────────────────────────────────
function renderForecast() {
  const f = DATA.retro_forecast || {};
  const sav = f.per_pipeline_savings || {};
  const totals = f.totals || {};
  const scaled = f.scaled || {};
  const tbody = document.getElementById('tbody-forecast');

  tbody.innerHTML = Object.entries(sav).map(([key, v]) => `
    <tr class="forecast-row">
      <td>${key.replace('_', ' ')}</td>
      <td class="num">${fmtNum(v.tokens_saved)}</td>
      <td class="num pos">${fmtCost(v.cost_saved_usd)}</td>
      <td>${v.rationale || ''}</td>
    </tr>
  `).join('') + `
    <tr class="forecast-row total-row">
      <td>Total per-pipeline</td>
      <td class="num">${fmtNum(totals.total_tokens_saved_per_pipeline)}</td>
      <td class="num pos">${fmtCost(totals.total_cost_saved_per_pipeline_usd)}</td>
      <td>${totals.pct_reduction ?? '—'}% reduction → projected ${fmtCost(totals.projected_cost_per_pipeline_usd)}/pipeline</td>
    </tr>
  `;

  document.getElementById('forecast-summary').innerHTML = `
    <strong>Scaled annual savings</strong>
    (assuming ${fmtNum(scaled.pipelines_per_month_assumption)} formal pipelines/month):
    <span class="pos">${fmtCost(scaled.annual_savings_usd)}/year</span>
    (<span class="pos">${fmtCost(scaled.monthly_savings_usd)}/month</span>).
    Note: applies to formal orchestration runs only.
  `;
}

// ── Retro subjects table ───────────────────────────────────────────────
function renderRetroSubjects() {
  const tbody = document.getElementById('tbody-retro-subjects');
  const bs = (DATA.retro_rollup || {}).by_subject || {};
  const sortedSubjects = Object.entries(bs).sort((a, b) => b[1].cost_usd - a[1].cost_usd);
  tbody.innerHTML = sortedSubjects.map(([subj, v]) => `
    <tr>
      <td>${subj}</td>
      <td class="num">${fmtNum(v.retros)}</td>
      <td class="num">${fmtTokens(v.tokens)}</td>
      <td class="num">${fmtCost(v.cost_usd)}</td>
      <td class="num">${v.wall_clock_min.toFixed(0)}</td>
    </tr>
  `).join('');
}

// ── Render all ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  try {
    renderKPIs();
    renderDaily();
    renderWeekly();
    renderModels();
    renderTokenMix();
    renderMainVsSub();
    renderProjects();
    renderSessions();
    renderForecast();
    renderRetroSubjects();
  } catch (e) {
    console.error('Dashboard render error:', e);
    const banner = document.createElement('div');
    banner.className = 'error-banner';
    banner.textContent = 'Error rendering dashboard: ' + e.message;
    document.body.insertBefore(banner, document.body.firstChild);
  }
});
</script>
</body>
</html>
"""


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--output", default=str(DEFAULT_OUTPUT))
    p.add_argument("--open", action="store_true", help="open in default browser")
    p.add_argument("--config", help="optional tokenomix config JSON path")
    p.add_argument("--projects-dir", help="override Claude projects dir")
    p.add_argument(
        "--exclude-cwd-prefix",
        action="append",
        default=[],
        help="exclude sessions whose resolved cwd is this path or a child path; repeatable",
    )
    p.add_argument(
        "--include-excluded",
        action="store_true",
        help="include sessions under configured exclusion prefixes",
    )
    p.add_argument(
        "--include-cowork",
        action="store_true",
        help=argparse.SUPPRESS,
    )
    args = p.parse_args()

    data = collect_data(
        include_excluded=args.include_excluded or args.include_cowork,
        config=args.config,
        projects_dir=args.projects_dir,
        exclude_cwd_prefixes=args.exclude_cwd_prefix,
    )
    errors = {
        key: value["error"]
        for key, value in data.items()
        if isinstance(value, dict) and value.get("error")
        and not (key.startswith("retro_") and value.get("error") == "no history entries found")
    }
    if errors:
        for key, err in errors.items():
            print(f"ERROR: {key}: {err}", file=sys.stderr)
        return 1

    json_text = json.dumps(data, indent=2)
    html = HTML_TEMPLATE.replace("__DATA_PLACEHOLDER__", json_text)

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(html)
    size_kb = out_path.stat().st_size / 1024
    print(f"Dashboard written to {out_path} ({size_kb:.1f} KB)", file=sys.stderr)

    if args.open:
        if sys.platform == "darwin":
            subprocess.run(["open", str(out_path)])
        elif sys.platform == "linux":
            subprocess.run(["xdg-open", str(out_path)])
        elif sys.platform == "win32":
            os.startfile(str(out_path))  # type: ignore

    return 0


if __name__ == "__main__":
    sys.exit(main())
