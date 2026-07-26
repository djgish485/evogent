"""Pure accessibility-tree proofs for X's home timeline.

The scraper must distinguish "X rendered something" from "the requested Following timeline is
selected." These helpers intentionally consume only the authenticated node dump, so they can be
fixture-tested without driving a live phone.
"""

from __future__ import annotations

import re
from typing import Optional

X_PACKAGE = "com.twitter.android"
_VALUE = re.compile(r'(?:text|desc)="([^"]*)"')
_STATE_MARKERS = ("[selected]", "[checked]")


def x_tree_ready(tree: str) -> bool:
    """True when a populated node dump belongs to X."""
    if not tree or "root=null" in tree:
        return False
    return bool(
        re.search(
            rf"^NODES[^\n]*\bpkg={re.escape(X_PACKAGE)}(?:\s|$)",
            tree,
            re.MULTILINE,
        )
    )


def _matches_label(value: str, label: str) -> bool:
    normalized = " ".join(value.strip().split()).casefold()
    expected = label.casefold()
    return normalized in {
        expected,
        f"{expected} tab",
        f"{expected}, tab",
    }


def _line_has_label(line: str, label: str) -> bool:
    return any(_matches_label(value, label) for value in _VALUE.findall(line))


def _line_selected(line: str) -> bool:
    return any(marker in line for marker in _STATE_MARKERS)


def timeline_tree_ready(tree: str) -> bool:
    """Prove X Home's two-tab timeline, excluding tweet/detail screens."""
    if not x_tree_ready(tree):
        return False
    if any(_line_has_label(line, "Navigate up") for line in tree.splitlines()):
        return False
    lines = tree.splitlines()
    return (
        any(_line_has_label(line, "For you") for line in lines)
        and any(_line_has_label(line, "Following") for line in lines)
    )


def selected_top_tab(tree: str) -> Optional[str]:
    """Return the uniquely selected top tab, including selection exposed on a parent node."""
    if not timeline_tree_ready(tree):
        return None

    # walk() emits indentation from the real node hierarchy. It now includes selected/checkable
    # nodes even when they have no text, so a tab container's state can be inherited by its label.
    stack: list[tuple[int, bool]] = []
    selected: set[str] = set()
    for raw in tree.splitlines()[1:]:
        content = raw.lstrip(" ")
        if not content:
            continue
        indent = len(raw) - len(content)
        while stack and stack[-1][0] >= indent:
            stack.pop()
        inherited = any(state for _, state in stack)
        state = inherited or _line_selected(content)
        for label in ("For you", "Following"):
            if _line_has_label(content, label) and state:
                selected.add(label)
        stack.append((indent, state))

    if len(selected) != 1:
        return None
    return next(iter(selected))


def following_timeline_ready(tree: str) -> bool:
    """True only with Home timeline structure and affirmative Following selection."""
    return selected_top_tab(tree) == "Following"
