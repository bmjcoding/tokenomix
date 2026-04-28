"""Runtime configuration helpers for tokenomix scripts.

The only path tokenomix can safely assume across users is the Claude Code
session root under `~/.claude`. Everything else, such as exclusion prefixes or
retro history files, must be configurable.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any


CONFIG_ENV = "TOKENOMIX_CONFIG"
CLAUDE_HOME_ENV = "TOKENOMIX_CLAUDE_HOME"
PROJECTS_DIR_ENV = "TOKENOMIX_PROJECTS_DIR"
EXCLUDE_CWD_PREFIXES_ENV = "TOKENOMIX_EXCLUDE_CWD_PREFIXES"
RETRO_HISTORY_PATHS_ENV = "TOKENOMIX_RETRO_HISTORY_PATHS"


@dataclass(frozen=True)
class TokenomixConfig:
    config_path: Path | None
    claude_home: Path
    projects_dir: Path
    exclude_cwd_prefixes: list[str]
    retro_history_paths: list[Path]


def default_config_paths() -> list[Path]:
    return [
        Path.home() / ".claude" / "tokenomix" / "config.json",
        Path.home() / ".config" / "tokenomix" / "config.json",
    ]


def default_retro_history_candidates() -> list[Path]:
    return []


def expand_path(value: str | Path) -> Path:
    return Path(os.path.expandvars(str(value))).expanduser()


def expand_prefix(value: str | Path) -> str:
    return str(expand_path(value)).rstrip("/")


def split_env_list(value: str | None) -> list[str]:
    if not value:
        return []
    # Prefer os.pathsep for path lists, but tolerate comma-separated values for
    # shell ergonomics in documentation and copy/paste snippets.
    parts: list[str] = []
    for chunk in value.split(os.pathsep):
        parts.extend(chunk.split(","))
    return [p.strip() for p in parts if p.strip()]


def _first_existing_config(explicit_path: str | Path | None) -> tuple[Path | None, dict[str, Any]]:
    if explicit_path:
        p = expand_path(explicit_path)
        if p.is_file():
            return p, json.loads(p.read_text())
        raise FileNotFoundError(f"tokenomix config file not found: {p}")

    env_path = os.environ.get(CONFIG_ENV)
    if env_path:
        p = expand_path(env_path)
        if p.is_file():
            return p, json.loads(p.read_text())
        raise FileNotFoundError(f"{CONFIG_ENV} points to a missing file: {p}")

    for p in default_config_paths():
        if p.is_file():
            return p, json.loads(p.read_text())
    return None, {}


def _list_from_config(data: dict[str, Any], key: str) -> list[str]:
    value = data.get(key)
    if value is None:
        return []
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [str(v) for v in value if str(v).strip()]
    return []


def load_config(config_path: str | Path | None = None) -> TokenomixConfig:
    loaded_path, data = _first_existing_config(config_path)

    claude_home_raw = (
        os.environ.get(CLAUDE_HOME_ENV)
        or data.get("claude_home")
        or str(Path.home() / ".claude")
    )
    claude_home = expand_path(str(claude_home_raw))

    projects_dir_raw = (
        os.environ.get(PROJECTS_DIR_ENV)
        or data.get("projects_dir")
        or str(claude_home / "projects")
    )
    projects_dir = expand_path(str(projects_dir_raw))

    exclude_prefixes = [
        expand_prefix(p)
        for p in _list_from_config(data, "exclude_cwd_prefixes")
    ]
    # Backward-compatible config key for the first local implementation.
    exclude_prefixes.extend(
        expand_prefix(p)
        for p in _list_from_config(data, "cowork_path_prefixes")
    )
    env_excludes = split_env_list(os.environ.get(EXCLUDE_CWD_PREFIXES_ENV))
    if env_excludes:
        exclude_prefixes = [expand_prefix(p) for p in env_excludes]

    retro_paths = [
        expand_path(p)
        for p in _list_from_config(data, "retro_history_paths")
    ]
    env_retro_paths = split_env_list(os.environ.get(RETRO_HISTORY_PATHS_ENV))
    if env_retro_paths:
        retro_paths = [expand_path(p) for p in env_retro_paths]
    if not retro_paths:
        retro_paths = default_retro_history_candidates()

    return TokenomixConfig(
        config_path=loaded_path,
        claude_home=claude_home,
        projects_dir=projects_dir,
        exclude_cwd_prefixes=list(dict.fromkeys(exclude_prefixes)),
        retro_history_paths=list(dict.fromkeys(retro_paths)),
    )
