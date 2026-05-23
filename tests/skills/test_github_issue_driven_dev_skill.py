"""
Smoke tests for the github-issue-driven-dev bundled skill.

Verifies SKILL.md frontmatter format, required sections, and cross-platform
support — no network or GitHub auth required.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest
import yaml

SKILL_DIR = Path(__file__).resolve().parents[2] / "skills" / "github" / "github-issue-driven-dev"
SKILL_MD = SKILL_DIR / "SKILL.md"

REQUIRED_SECTIONS = [
    "Step 1",
    "Step 2",
    "Step 3",
    "Step 4",
    "Step 5",
    "Step 6",
    "Step 7",
    "Fork Workflow",
    "Quick Reference",
]


@pytest.fixture(scope="module")
def skill_src() -> str:
    return SKILL_MD.read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def frontmatter(skill_src: str) -> dict:
    m = re.search(r"^---\n(.*?)\n---", skill_src, re.DOTALL)
    assert m, "SKILL.md missing YAML frontmatter"
    return yaml.safe_load(m.group(1))


def test_skill_dir_exists() -> None:
    assert SKILL_DIR.is_dir(), f"missing skill dir: {SKILL_DIR}"


def test_skill_md_present() -> None:
    assert SKILL_MD.is_file()


def test_name_matches_dir(frontmatter: dict) -> None:
    assert frontmatter["name"] == "github-issue-driven-dev"


def test_description_under_60_chars(frontmatter: dict) -> None:
    desc = frontmatter["description"]
    assert len(desc) <= 60, f"description is {len(desc)} chars (limit 60): {desc!r}"


def test_version_present(frontmatter: dict) -> None:
    assert "version" in frontmatter
    assert re.match(r"^\d+\.\d+\.\d+$", str(frontmatter["version"]))


def test_license_mit(frontmatter: dict) -> None:
    assert frontmatter.get("license") == "MIT"


def test_platforms_cross_platform(frontmatter: dict) -> None:
    platforms = frontmatter.get("platforms", [])
    assert set(platforms) >= {"linux", "macos", "windows"}, (
        f"skill should support all platforms, got: {platforms}"
    )


def test_related_skills_present(frontmatter: dict) -> None:
    related = frontmatter.get("metadata", {}).get("hermes", {}).get("related_skills", [])
    assert "github-auth" in related
    assert "github-issues" in related
    assert "github-pr-workflow" in related


def test_tags_present(frontmatter: dict) -> None:
    tags = frontmatter.get("metadata", {}).get("hermes", {}).get("tags", [])
    assert len(tags) >= 3, f"expected at least 3 tags, got {tags}"


def test_required_sections_present(skill_src: str) -> None:
    for section in REQUIRED_SECTIONS:
        assert section in skill_src, f"missing expected section: {section!r}"


def test_gh_commands_present(skill_src: str) -> None:
    assert "gh issue" in skill_src
    assert "gh pr create" in skill_src
    assert "gh issue develop" in skill_src


def test_curl_fallbacks_present(skill_src: str) -> None:
    assert "curl" in skill_src
    assert "GITHUB_TOKEN" in skill_src


def test_closes_keyword_documented(skill_src: str) -> None:
    assert "Closes #" in skill_src


def test_fork_workflow_documented(skill_src: str) -> None:
    assert "git remote add fork" in skill_src
    assert "gh repo fork" in skill_src
