#!/usr/bin/env python3
"""Tests for the tokenomix project (~/.claude/tokenomix/).

Covers:
    - claude-usage.py: model-aware pricing, dedup, subagent inclusion
    - retro-trends.py: rollup, timeline, forecast, report commands
    - usage-dashboard.py: HTML generation, embedded data, all sections present

Run with:
    python3 ~/.claude/tokenomix/tests/test_tokenomix.py

Exit codes:
    0  all tests passed
    1  one or more tests failed
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

# bin/ is a sibling of tests/ — resolve relative to this file.
PROJECT_ROOT = Path(__file__).resolve().parent.parent
BIN = PROJECT_ROOT / "bin"


class TestResult:
    def __init__(self):
        self.passed = 0
        self.failed: list[str] = []

    def check(self, name: str, ok: bool, detail: str = "") -> None:
        status = "PASS" if ok else "FAIL"
        print(f"  {status}: {name}" + (f" — {detail}" if detail and not ok else ""))
        if ok:
            self.passed += 1
        else:
            self.failed.append(f"{name}: {detail}")

    def report(self) -> int:
        total = self.passed + len(self.failed)
        print(f"\n{self.passed}/{total} passed")
        if self.failed:
            print("\nFailures:")
            for f in self.failed:
                print(f"  - {f}")
            return 1
        return 0


def run(cmd: list[str], stdin: str | None = None, env: dict | None = None) -> tuple[int, str, str]:
    proc = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        input=stdin,
        env=env,
    )
    return proc.returncode, proc.stdout, proc.stderr


# ─────────────────────────────────────────────────────────────────────────────
# claude-usage.py
# ─────────────────────────────────────────────────────────────────────────────


def test_claude_usage(r: TestResult) -> None:
    """claude-usage.py: model-aware pricing on synthetic conversation logs."""
    print("claude-usage.py")
    script = BIN / "claude-usage.py"
    if not script.exists():
        r.check("claude-usage.py exists", False, "missing")
        return

    with tempfile.TemporaryDirectory() as td:
        # Synthesize a Claude Code conversation log layout.
        projects_dir = Path(td) / "projects"
        proj = projects_dir / "-Users-bmj-test-project"
        proj.mkdir(parents=True)
        session = proj / "test-session-uuid.jsonl"

        # Five events:
        #   - opus + sonnet + top-level-cache sonnet + haiku (4 unique requests in main session)
        #   - one duplicate of the opus event (same requestId + msg.id) to test dedup
        #   - one event in a subagent file (to test recursive glob + is_subagent flag)
        events = [
            {
                "type": "assistant", "timestamp": "2026-04-27T10:00:00Z",
                "requestId": "req_opus_001",
                "message": {
                    "id": "msg_opus_001",
                    "model": "claude-opus-4-7",
                    "usage": {
                        "input_tokens": 1_000,
                        "output_tokens": 500,
                        "cache_creation_input_tokens": 0,
                        "cache_read_input_tokens": 100_000,
                        "cache_creation": {
                            "ephemeral_5m_input_tokens": 0,
                            "ephemeral_1h_input_tokens": 0,
                        },
                    },
                },
            },
            # DUPLICATE: same requestId+msg.id (thinking block + text block of one
            # API call). Should be deduped by claude-usage.py.
            {
                "type": "assistant", "timestamp": "2026-04-27T10:00:01Z",
                "requestId": "req_opus_001",
                "message": {
                    "id": "msg_opus_001",
                    "model": "claude-opus-4-7",
                    "usage": {
                        "input_tokens": 1_000,
                        "output_tokens": 500,
                        "cache_creation_input_tokens": 0,
                        "cache_read_input_tokens": 100_000,
                        "cache_creation": {
                            "ephemeral_5m_input_tokens": 0,
                            "ephemeral_1h_input_tokens": 0,
                        },
                    },
                },
            },
            {
                "type": "assistant", "timestamp": "2026-04-27T10:05:00Z",
                "requestId": "req_sonnet_001",
                "message": {
                    "id": "msg_sonnet_001",
                    "model": "claude-sonnet-4-6",
                    "usage": {
                        "input_tokens": 2_000,
                        "output_tokens": 1_000,
                        "cache_creation_input_tokens": 0,
                        "cache_read_input_tokens": 50_000,
                        "cache_creation": {
                            "ephemeral_5m_input_tokens": 0,
                            "ephemeral_1h_input_tokens": 0,
                        },
                    },
                },
            },
            {
                "type": "assistant", "timestamp": "2026-04-27T10:07:00Z",
                "requestId": "req_sonnet_top_cache_001",
                "message": {
                    "id": "msg_sonnet_top_cache_001",
                    "model": "claude-sonnet-4-6",
                    "usage": {
                        "input_tokens": 0,
                        "output_tokens": 0,
                        # Legacy/edge Claude Code schema: top-level cache
                        # creation tokens with no nested TTL split. This must
                        # price as 5-minute cache write, not disappear.
                        "cache_creation_input_tokens": 10_000,
                        "cache_read_input_tokens": 0,
                        "server_tool_use": {"web_search_requests": 2},
                    },
                },
            },
            {
                "type": "assistant", "timestamp": "2026-04-27T10:10:00Z",
                "requestId": "req_haiku_001",
                "message": {
                    "id": "msg_haiku_001",
                    "model": "claude-haiku-4-5",
                    "usage": {
                        "input_tokens": 5_000,
                        "output_tokens": 2_000,
                        "cache_creation_input_tokens": 10_000,
                        "cache_read_input_tokens": 0,
                        "cache_creation": {
                            "ephemeral_5m_input_tokens": 10_000,
                            "ephemeral_1h_input_tokens": 0,
                        },
                    },
                },
            },
        ]

        with session.open("w") as f:
            for e in events:
                f.write(json.dumps(e) + "\n")

        # Subagent log: <session>/subagents/agent-X.jsonl
        subagent_dir = proj / "test-session-uuid" / "subagents"
        subagent_dir.mkdir(parents=True)
        sub_log = subagent_dir / "agent-aaaaaa.jsonl"
        sub_event = {
            "type": "assistant", "timestamp": "2026-04-27T10:15:00Z",
            "requestId": "req_subagent_001",
            "message": {
                "id": "msg_subagent_001",
                "model": "claude-sonnet-4-6",
                "usage": {
                    "input_tokens": 100,
                    "output_tokens": 50,
                    "cache_creation_input_tokens": 0,
                    "cache_read_input_tokens": 5_000,
                    "cache_creation": {
                        "ephemeral_5m_input_tokens": 0,
                        "ephemeral_1h_input_tokens": 0,
                    },
                },
            },
        }
        with sub_log.open("w") as f:
            f.write(json.dumps(sub_event) + "\n")

        # The script reads from a hard-coded path. We override it via env-tweak:
        # use HOME to redirect the .claude/projects discovery.
        env = {**os.environ, "HOME": str(td)}
        # We need .claude/projects under HOME, so symlink it.
        (Path(td) / ".claude").mkdir()
        (Path(td) / ".claude" / "projects").symlink_to(projects_dir)

        # totals: should dedupe the duplicate opus event AND include subagent
        rc, out, err = run(["python3", str(script), "totals"], env=env)
        r.check("totals exits 0", rc == 0, err)
        if rc == 0:
            data = json.loads(out)
            # 5 unique requestIds (opus dedup'd, sonnet, top-cache sonnet, haiku,
            # subagent_sonnet) — NOT 6 raw events.
            r.check(
                f"totals dedups to 5 events (got {data['events']})",
                data["events"] == 5,
                str(data["events"]),
            )
            r.check("opus is in by_model", "opus" in data.get("by_model", {}))
            r.check("sonnet is in by_model", "sonnet" in data.get("by_model", {}))
            r.check("haiku is in by_model", "haiku" in data.get("by_model", {}))
            # Sanity-check pricing arithmetic for opus event using current
            # Opus 4.5+ rates ($5/$25/$0.50 input/output/cache_read):
            #   1k input × $5/Mtok       = $0.005
            #   500 output × $25/Mtok    = $0.0125
            #   100k cache_read × $0.50  = $0.05
            #   total opus event ≈       = $0.0675
            opus_cost = data["by_model"]["opus"]["cost_usd"]
            r.check(
                f"opus 4.7 cost ≈ $0.07 (got ${opus_cost})",
                abs(opus_cost - 0.0675) < 0.01,
                f"computed ${opus_cost}",
            )
            sonnet_cost = data["by_model"]["sonnet"]["cost_usd"]
            r.check(
                "top-level cache_creation_input_tokens and web search requests are priced",
                sonnet_cost == 0.10,
                f"computed sonnet cost ${sonnet_cost}",
            )
            sb = data.get("subagent_breakdown", {})
            r.check("subagent_breakdown exists", bool(sb), "missing subagent_breakdown")
            r.check(
                "subagent_breakdown counts 1 subagent event",
                sb.get("subagent_events") == 1,
                f"got {sb.get('subagent_events')}",
            )
            r.check(
                "subagent_breakdown counts 4 main-session events",
                sb.get("main_session_events") == 4,
                f"got {sb.get('main_session_events')}",
            )

        # by-model
        rc, out, err = run(["python3", str(script), "by_model"], env=env)
        r.check("by_model exits 0", rc == 0, err)
        if rc == 0:
            data = json.loads(out)
            r.check("by_model has 3 families", len(data["by_model"]) == 3)

        # daily
        rc, out, err = run(["python3", str(script), "daily"], env=env)
        r.check("daily exits 0", rc == 0, err)
        if rc == 0:
            data = json.loads(out)
            r.check("daily has 1 day", len(data["days"]) == 1)


def test_model_family_pricing(r: TestResult) -> None:
    """claude-usage.py: version-aware family detection + correct pricing tables."""
    print("model-family pricing")
    script = BIN / "claude-usage.py"
    if not script.exists():
        r.check("claude-usage.py exists", False, "missing")
        return

    import importlib.util
    spec = importlib.util.spec_from_file_location("cu", str(script))
    cu = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(cu)

    cases = [
        ("claude-opus-4-7",         "opus"),
        ("claude-opus-4-6",         "opus"),
        ("claude-opus-4-5",         "opus"),
        ("claude-opus-4-5-20251101","opus"),
        ("claude-opus-4-1",         "opus_legacy"),
        ("claude-opus-4-0",         "opus_legacy"),
        ("claude-opus-3",           "opus_legacy"),
        ("claude-sonnet-4-6",       "sonnet"),
        ("claude-sonnet-3-7",       "sonnet"),
        ("claude-haiku-4-5",        "haiku"),
        ("claude-haiku-3-5",        "haiku_3_5"),
        ("claude-haiku-3",          "haiku_3"),
        ("<synthetic>",             "sonnet"),
        (None,                      "sonnet"),
    ]
    for model_id, expected in cases:
        actual = cu.model_family(model_id)
        r.check(
            f"family({model_id!r}) == {expected!r}",
            actual == expected,
            f"got {actual!r}",
        )

    # Spot-check the Opus 4.5+ price table is the new (3x cheaper) one.
    opus_modern = cu.MODEL_PRICES["opus"]
    r.check("opus modern input is $5", opus_modern["input"] == 5.00, str(opus_modern["input"]))
    r.check("opus modern output is $25", opus_modern["output"] == 25.00, str(opus_modern["output"]))
    r.check("opus modern cache_read is $0.50", opus_modern["cache_read"] == 0.50, str(opus_modern["cache_read"]))
    opus_legacy = cu.MODEL_PRICES["opus_legacy"]
    r.check("opus legacy input is $15", opus_legacy["input"] == 15.00, str(opus_legacy["input"]))
    r.check("opus legacy output is $75", opus_legacy["output"] == 75.00, str(opus_legacy["output"]))
    r.check(
        "web search request price is $0.01",
        cu.WEB_SEARCH_USD_PER_REQUEST == 0.01,
        str(cu.WEB_SEARCH_USD_PER_REQUEST),
    )
    r.check(
        "US-only + fast + batch modifiers stack",
        abs(cu.pricing_multiplier_for_usage(
            "claude-opus-4-6",
            {"inference_geo": "us", "speed": "fast", "service_tier": "batch"},
        ) - 3.3) < 1e-9,
        str(cu.pricing_multiplier_for_usage(
            "claude-opus-4-6",
            {"inference_geo": "us", "speed": "fast", "service_tier": "batch"},
        )),
    )
    r.check(
        "fast mode premium is model-scoped to currently supported Opus 4.6",
        abs(cu.pricing_multiplier_for_usage(
            "claude-sonnet-4-6",
            {"speed": "fast"},
        ) - 1.0) < 1e-9,
        str(cu.pricing_multiplier_for_usage(
            "claude-sonnet-4-6",
            {"speed": "fast"},
        )),
    )


def test_cwd_prefix_exclusion(r: TestResult) -> None:
    """claude-usage.py: configured cwd-prefix exclusions are applied by default;
    --include-excluded brings them back. Matching is path-segment anchored."""
    print("cwd-prefix exclusion")
    script = BIN / "claude-usage.py"
    if not script.exists():
        r.check("claude-usage.py exists", False, "missing")
        return

    import importlib.util
    spec = importlib.util.spec_from_file_location("cu", str(script))
    cu = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(cu)

    # Boundary-anchored prefix match (no partial-segment false positives).
    prefixes = ["/Users/example/excluded"]
    cases = [
        ("/Users/example/excluded",                 True),
        ("/Users/example/excluded/subdir",          True),
        ("/Users/example/excluded/subdir/session",  True),
        ("/Users/example/excluded-sibling",         False),  # not a child path
        ("/Users/example/src/application",          False),
        ("/Users/example",                          False),
    ]
    for cwd, expected in cases:
        actual = cu.is_excluded_cwd(cwd, prefixes)
        r.check(
            f"is_excluded_cwd({cwd!r}) == {expected}",
            actual == expected,
            f"got {actual!r}",
        )

    # End-to-end: synthesize an excluded project + a regular project, configure
    # the excluded prefix via env, then verify default-exclude / opt-in.
    with tempfile.TemporaryDirectory() as td:
        projects_dir = Path(td) / "projects"
        excluded_proj = projects_dir / "-Users-example-excluded"
        excluded_proj.mkdir(parents=True)
        eng_proj = projects_dir / "-Users-example-src-eng"
        eng_proj.mkdir(parents=True)

        common_usage = {
            "input_tokens": 1000, "output_tokens": 500,
            "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0,
            "cache_creation": {"ephemeral_5m_input_tokens": 0,
                               "ephemeral_1h_input_tokens": 0},
        }
        # Subprocess sees TOKENOMIX_EXCLUDE_CWD_PREFIXES=<td>/excluded.
        # Match that for the excluded event's cwd.
        for proj, cwd, rid_mid in [
            (excluded_proj, str(Path(td) / "excluded"),           ("req_ex", "msg_ex")),
            (eng_proj,      str(Path(td) / "src" / "eng"),        ("req_eng", "msg_eng")),
        ]:
            event = {
                "type": "assistant", "timestamp": "2026-04-27T10:00:00Z",
                "cwd": cwd,
                "requestId": rid_mid[0],
                "message": {
                    "id": rid_mid[1], "model": "claude-sonnet-4-6",
                    "usage": common_usage,
                },
            }
            with (proj / "session.jsonl").open("w") as f:
                f.write(json.dumps(event) + "\n")

        env = {
            **os.environ,
            "HOME": str(td),
            "TOKENOMIX_EXCLUDE_CWD_PREFIXES": str(Path(td) / "excluded"),
        }
        (Path(td) / ".claude").mkdir()
        (Path(td) / ".claude" / "projects").symlink_to(projects_dir)

        rc, out, err = run(["python3", str(script), "totals"], env=env)
        r.check("totals exits 0 (prefix excluded)", rc == 0, err)
        if rc == 0:
            data = json.loads(out)
            r.check(
                f"default excludes configured prefix (events={data['events']}, expected 1)",
                data["events"] == 1,
                str(data["events"]),
            )
            r.check(
                "filter.include_excluded is False",
                data["filter"]["include_excluded"] is False,
            )
            r.check(
                "filter.exclude_cwd_prefixes reports env prefix",
                data["filter"]["exclude_cwd_prefixes"] == [str(Path(td) / "excluded")],
                str(data["filter"]["exclude_cwd_prefixes"]),
            )

        rc, out, err = run(["python3", str(script), "totals", "--include-excluded"], env=env)
        r.check("totals --include-excluded exits 0", rc == 0, err)
        if rc == 0:
            data = json.loads(out)
            r.check(
                f"--include-excluded keeps excluded prefix (events={data['events']}, expected 2)",
                data["events"] == 2,
                str(data["events"]),
            )
            r.check(
                "filter.include_excluded is True",
                data["filter"]["include_excluded"] is True,
            )


def test_runtime_config(r: TestResult) -> None:
    """claude-usage.py: explicit config controls project discovery and exclusions."""
    print("runtime config")
    script = BIN / "claude-usage.py"
    if not script.exists():
        r.check("claude-usage.py exists", False, "missing")
        return

    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        projects_dir = root / "custom-projects"
        excluded_proj = projects_dir / "-Org-automation"
        regular_proj = projects_dir / "-Org-engineering"
        excluded_proj.mkdir(parents=True)
        regular_proj.mkdir(parents=True)

        usage = {
            "input_tokens": 1000,
            "output_tokens": 0,
            "cache_creation_input_tokens": 0,
            "cache_read_input_tokens": 0,
        }
        for proj, cwd, rid in [
            (excluded_proj, str(root / "automation"), "req_auto"),
            (regular_proj, str(root / "engineering"), "req_eng"),
        ]:
            event = {
                "type": "assistant",
                "timestamp": "2026-04-27T10:00:00Z",
                "cwd": cwd,
                "requestId": rid,
                "message": {
                    "id": rid.replace("req_", "msg_"),
                    "model": "claude-sonnet-4-6",
                    "usage": usage,
                },
            }
            with (proj / "session.jsonl").open("w") as f:
                f.write(json.dumps(event) + "\n")

        config_path = root / "tokenomix.json"
        config_path.write_text(json.dumps({
            "projects_dir": str(projects_dir),
            "exclude_cwd_prefixes": [str(root / "automation")],
            "retro_history_paths": [],
        }))

        rc, out, err = run(["python3", str(script), "totals", "--config", str(config_path)])
        r.check("totals --config exits 0", rc == 0, err)
        if rc == 0:
            data = json.loads(out)
            r.check("config projects_dir is used", data["filter"]["projects_dir"] == str(projects_dir))
            r.check("config exclusion drops automation event", data["events"] == 1, str(data["events"]))

        rc, out, err = run([
            "python3", str(script), "totals",
            "--config", str(config_path),
            "--include-excluded",
        ])
        r.check("totals --config --include-excluded exits 0", rc == 0, err)
        if rc == 0:
            data = json.loads(out)
            r.check("include-excluded keeps config excluded event", data["events"] == 2, str(data["events"]))

        missing_config = root / "missing.json"
        rc, out, err = run(["python3", str(script), "totals", "--config", str(missing_config)])
        r.check("missing explicit config fails", rc == 2, f"rc={rc}, stdout={out}, stderr={err}")


def test_parse_iso_timezone(r: TestResult) -> None:
    """claude-usage.py: parse_iso converts UTC `Z`-suffixed timestamps to local
    time so daily bucketing reflects the user's wall-clock day, not UTC."""
    print("parse_iso timezone")
    script = BIN / "claude-usage.py"
    if not script.exists():
        r.check("claude-usage.py exists", False, "missing")
        return

    import importlib.util
    from datetime import datetime, timezone
    spec = importlib.util.spec_from_file_location("cu", str(script))
    cu = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(cu)

    # A UTC instant — convert to local; expected local equals what astimezone gives.
    expected_local_naive = (
        datetime(2026, 4, 27, 1, 30, tzinfo=timezone.utc)
        .astimezone()
        .replace(tzinfo=None)
    )
    parsed = cu.parse_iso("2026-04-27T01:30:00Z")
    r.check(
        f"Z timestamp converted to local ({parsed} == {expected_local_naive})",
        parsed == expected_local_naive,
        f"got {parsed!r}",
    )

    # Non-Z timestamp passes through unchanged.
    parsed_naive = cu.parse_iso("2026-04-27T01:30:00")
    r.check(
        "naive timestamp parses unchanged",
        parsed_naive == datetime(2026, 4, 27, 1, 30),
        f"got {parsed_naive!r}",
    )

    # None / empty / unparseable safely return None.
    r.check("None input returns None", cu.parse_iso(None) is None)
    r.check("empty input returns None", cu.parse_iso("") is None)
    r.check("garbage input returns None", cu.parse_iso("not-a-date") is None)


# ─────────────────────────────────────────────────────────────────────────────
# retro-trends.py
# ─────────────────────────────────────────────────────────────────────────────


def test_retro_trends(r: TestResult) -> None:
    """retro-trends.py: rollup, timeline, forecast, report commands."""
    print("retro-trends.py")
    script = BIN / "retro-trends.py"
    if not script.exists():
        r.check("retro-trends.py exists", False, "missing")
        return

    with tempfile.TemporaryDirectory() as td:
        history_dir = Path(td)
        history_path = history_dir / "history.jsonl"
        with history_path.open("w") as f:
            for entry in [
                {"timestamp": "2026-04-21T22:00:00", "summary": {
                    "subject": "orchestrator", "session_id": "S1",
                    "total_tokens": 2000000, "total_cost_usd": 18.0,
                    "wall_clock_min": 100, "agents_spawned": 30,
                    "findings_total": 20, "verdict": "CLEAR_TO_SHIP",
                }},
                {"timestamp": "2026-04-22T08:00:00", "summary": {
                    "subject": "audit-p1", "session_id": "S2",
                    "total_tokens": 1500000, "total_cost_usd": 13.5,
                    "wall_clock_min": 60, "agents_spawned": 25,
                    "findings_total": 12, "verdict": "SHIP_WITH_CAUTION",
                }},
            ]:
                f.write(json.dumps(entry) + "\n")

        env = {**os.environ, "AGENT_RETRO_DIR": str(history_dir)}

        rc, out, err = run(["python3", str(script), "rollup", "--by", "month"], env=env)
        r.check("rollup exits 0", rc == 0, err)
        if rc == 0:
            data = json.loads(out)
            r.check("rollup totals tokens", data["total_tokens"] == 3500000)
            r.check("rollup totals cost", data["total_cost_usd"] == 31.5)
            r.check("rollup includes by_month", "by_month" in data)

        rc, out, err = run(["python3", str(script), "timeline"], env=env)
        r.check("timeline exits 0", rc == 0, err)
        if rc == 0:
            data = json.loads(out)
            r.check("timeline returns 2 rows", data["row_count"] == 2)

        rc, out, err = run(
            ["python3", str(script), "forecast", "--pipelines-per-month", "10"],
            env=env,
        )
        r.check("forecast exits 0", rc == 0, err)
        if rc == 0:
            data = json.loads(out)
            r.check("forecast has totals", "totals" in data)
            r.check(
                "forecast totals.pct_reduction is positive",
                data["totals"]["pct_reduction"] > 0,
            )
            r.check(
                "forecast scales to monthly",
                data["scaled"]["pipelines_per_month_assumption"] == 10,
            )

        rc, out, err = run(
            ["python3", str(script), "forecast",
             "--override", "truncation_rate=0.0",
             "--override", "handoff_rejection_rate=0.0",
             "--pipelines-per-month", "10"],
            env=env,
        )
        r.check("forecast accepts overrides", rc == 0, err)
        if rc == 0:
            data = json.loads(out)
            r.check(
                "override zeroes out REC-1 savings",
                data["per_pipeline_savings"]["REC-1_handoff_validation"]["tokens_saved"] == 0,
            )

        rc, out, err = run(["python3", str(script), "report"], env=env)
        r.check("report exits 0", rc == 0, err)
        if rc == 0:
            r.check("report contains 'All-Time Rollup'", "All-Time Rollup" in out)
            r.check("report contains 'Forecast'", "Forecast" in out)


# ─────────────────────────────────────────────────────────────────────────────
# usage-dashboard.py
# ─────────────────────────────────────────────────────────────────────────────


def test_usage_dashboard(r: TestResult) -> None:
    """usage-dashboard.py: smoke test that it generates valid HTML with embedded data."""
    print("usage-dashboard.py")
    script = BIN / "usage-dashboard.py"
    if not script.exists():
        r.check("usage-dashboard.py exists", False, "missing")
        return

    with tempfile.TemporaryDirectory() as td:
        out_path = Path(td) / "dash.html"
        rc, _, err = run(["python3", str(script), "--output", str(out_path)])
        r.check("dashboard generates without error", rc == 0, err[:200])
        if rc == 0:
            r.check("dashboard file exists", out_path.exists())
            content = out_path.read_text()
            r.check("dashboard is non-trivial size", len(content) > 10000, f"got {len(content)} bytes")
            r.check("dashboard embeds Chart.js", "chart.js" in content.lower())
            r.check("dashboard embeds data", "const DATA = {" in content)
            r.check("dashboard has KPI cards", 'id="kpi-alltime-cost"' in content)
            r.check("dashboard has daily chart", 'id="chart-daily"' in content)
            r.check("dashboard has model chart", 'id="chart-models"' in content)
            r.check("dashboard has token mix chart", 'id="chart-tokenmix"' in content)
            r.check("dashboard has main-vs-sub chart", 'id="chart-main-vs-sub"' in content)
            r.check("dashboard has projects table", 'id="tbody-projects"' in content)
            r.check("dashboard has sessions table", 'id="tbody-sessions"' in content)
            r.check("dashboard has forecast table", 'id="tbody-forecast"' in content)


def main() -> int:
    if not BIN.is_dir():
        print(f"ERROR: bin directory not found: {BIN}", file=sys.stderr)
        return 1

    r = TestResult()
    for fn in [
        test_claude_usage,
        test_model_family_pricing,
        test_cwd_prefix_exclusion,
        test_runtime_config,
        test_parse_iso_timezone,
        test_retro_trends,
        test_usage_dashboard,
    ]:
        try:
            fn(r)
        except Exception as exc:
            r.failed.append(f"{fn.__name__}: exception {exc!r}")

    return r.report()


if __name__ == "__main__":
    sys.exit(main())
