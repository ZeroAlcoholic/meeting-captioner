"""Static security policy for offline service launch entry points."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

OFFLINE_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = OFFLINE_ROOT.parents[1]


@pytest.mark.parametrize("relative", ["start.bat", "start.sh"])
def test_production_launcher_is_loopback_only_without_reload(relative: str) -> None:
    text = (OFFLINE_ROOT / relative).read_text(encoding="utf-8")

    assert "0.0.0.0" not in text
    assert "--reload" not in text
    assert "127.0.0.1" in text


@pytest.mark.parametrize("relative", ["start.bat", "start.sh"])
def test_production_launcher_uses_shared_whl_entrypoint(relative: str) -> None:
    text = (OFFLINE_ROOT / relative).read_text(encoding="utf-8")

    assert "run_whl.py" in text


def test_shell_launcher_always_cleans_up_whl() -> None:
    text = (OFFLINE_ROOT / "start.sh").read_text(encoding="utf-8")

    assert "trap cleanup EXIT" in text


def test_whl_is_loopback_only() -> None:
    text = (OFFLINE_ROOT / "run_whl.py").read_text(encoding="utf-8")

    assert 'host="127.0.0.1"' in text


def test_root_dev_full_uses_uv_and_never_wildcard_binds() -> None:
    package = json.loads((REPO_ROOT / "package.json").read_text(encoding="utf-8"))
    command = package["scripts"]["dev:full"]

    assert "0.0.0.0" not in command
    assert '"python ' not in command
    assert "uv run python run_whl.py" in command
    assert "--host 127.0.0.1" in command


def test_documented_reload_command_is_explicitly_loopback_only() -> None:
    text = (OFFLINE_ROOT / "README.md").read_text(encoding="utf-8")
    reload_lines = [line for line in text.splitlines() if "--reload" in line]

    assert reload_lines
    assert all("--host 127.0.0.1" in line for line in reload_lines)
