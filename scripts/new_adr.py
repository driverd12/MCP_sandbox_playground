#!/usr/bin/env python3
"""
Create a new ADR file in docs/ADR and update docs/ADR/0000-index.md.

Usage:
  python3 scripts/new_adr.py --title "My Decision Title"
  python3 scripts/new_adr.py --title "My Decision Title" --status Accepted
  python3 scripts/new_adr.py --title "My Decision Title" --owners "Platform Engineering" --applies-to "src/, scripts/"

Notes:
- Status defaults to Proposed.
- If status is Accepted, the ADR will be added under "Active (Accepted)" in the index.
- Otherwise it will be added under "Proposed".
"""

from __future__ import annotations

import argparse
import datetime as dt
import os
import re
import sys
from pathlib import Path


ADR_DIR = Path("docs/ADR")
INDEX_FILE = ADR_DIR / "0000-index.md"


def slugify(title: str) -> str:
    s = title.strip().lower()
    s = re.sub(r"[^a-z0-9\s-]", "", s)
    s = re.sub(r"[\s_-]+", "-", s)
    s = re.sub(r"^-+|-+$", "", s)
    return s or "untitled"


def next_adr_number(adr_dir: Path) -> int:
    pattern = re.compile(r"^(\d{4})-.*\.md$")
    max_n = 0
    if not adr_dir.exists():
        return 1
    for p in adr_dir.iterdir():
        if not p.is_file():
            continue
        m = pattern.match(p.name)
        if not m:
            continue
        n = int(m.group(1))
        max_n = max(max_n, n)
    # 0000-index.md counts; next after max is fine (max will be >= 0)
    return max_n + 1 if max_n else 1


def render_adr(n: int, title: str, status: str, date: str, owners: str, applies_to: str) -> str:
    # Keep this template aligned with docs/ADR/README.md
    return f"""# ADR {n:04d}: {title}

- **Status:** {status}
- **Date:** {date}
- **Owners:** {owners}
- **Applies To:** {applies_to}

## Context
What problem are we solving? What constraints exist? What risks are in play?

## Decision
What are we doing? Be explicit. Define invariants and boundaries.

## Consequences
### Positive
What gets better / easier / safer?

### Negative / Tradeoffs
What gets worse / harder / slower?

## Alternatives Considered
List 2–3 real alternatives and why they were rejected.

## Rollback / Migration Plan
How do we undo this decision safely? If there’s a phased rollout, describe it.

## References
Links to files, docs, tickets, diagrams, examples.
"""


def ensure_index_exists() -> None:
    if INDEX_FILE.exists():
        return
    ADR_DIR.mkdir(parents=True, exist_ok=True)
    INDEX_FILE.write_text(
        """# MCP Sandbox ADR Index

This file is the table of contents for MCP Sandbox Architecture Decision Records (ADRs).

## Active (Accepted)

> None yet.

## Proposed

> None yet.

## Deprecated

> None yet.

## Superseded

> None yet.
""",
        encoding="utf-8",
    )


def insert_into_index(index_text: str, section_heading: str, bullet_block: str) -> str:
    """
    Insert bullet_block right after the target section heading.
    Also removes a "> None yet." placeholder inside that section if present.
    """
    # Find heading
    heading_re = re.compile(rf"^(##\s+{re.escape(section_heading)}\s*)$", re.MULTILINE)
    m = heading_re.search(index_text)
    if not m:
        raise ValueError(f'Could not find section "## {section_heading}" in {INDEX_FILE}')

    insert_pos = m.end()

    # Determine end of this section (next ## or end)
    next_heading = re.search(r"^##\s+", index_text[insert_pos:], flags=re.MULTILINE)
    section_end = insert_pos + (next_heading.start() if next_heading else len(index_text) - insert_pos)
    section_body = index_text[insert_pos:section_end]

    # Remove placeholder if present
    section_body_new = re.sub(r"^\s*>\s*None yet\.\s*\n?", "", section_body, flags=re.MULTILINE)

    # If already present, don't duplicate
    if bullet_block.strip() in section_body_new:
        return index_text

    # Ensure spacing: one blank line after heading, then content
    if not section_body_new.startswith("\n"):
        section_body_new = "\n" + section_body_new
    if not section_body_new.startswith("\n\n"):
        section_body_new = "\n" + section_body_new

    # Insert at top of section body (after heading)
    section_body_new = section_body_new.lstrip("\n")
    section_body_new = "\n\n" + bullet_block.rstrip() + "\n" + section_body_new
    return index_text[:insert_pos] + section_body_new + index_text[section_end:]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--title", required=True, help="ADR title, e.g. 'Retention policy update'")
    ap.add_argument("--status", default="Proposed", help="Proposed|Accepted|Deprecated|Superseded")
    ap.add_argument("--owners", default="Platform Engineering", help="Owner string")
    ap.add_argument("--applies-to", default="src/, scripts/, docs/", help="Paths/modules affected")
    args = ap.parse_args()

    title = args.title.strip()
    if not title:
        print("ERROR: --title cannot be empty", file=sys.stderr)
        return 2

    status = args.status.strip()
    today = dt.date.today().isoformat()

    ADR_DIR.mkdir(parents=True, exist_ok=True)
    ensure_index_exists()

    n = next_adr_number(ADR_DIR)
    slug = slugify(title)
    filename = f"{n:04d}-{slug}.md"
    adr_path = ADR_DIR / filename

    if adr_path.exists():
        print(f"ERROR: ADR file already exists: {adr_path}", file=sys.stderr)
        return 2

    adr_text = render_adr(n, title, status, today, args.owners, args.applies_to)
    adr_path.write_text(adr_text, encoding="utf-8")

    # Update index
    index_text = INDEX_FILE.read_text(encoding="utf-8")
    link = f"{filename}"
    bullet_block = f'- **[ADR {n:04d}: {title}]({link})**\n  Status: {status}\n  Date: {today}'

    section = "Active (Accepted)" if status.lower() == "accepted" else "Proposed"
    index_text = insert_into_index(index_text, section, bullet_block)
    INDEX_FILE.write_text(index_text, encoding="utf-8")

    print(f"Created: {adr_path}")
    print(f"Updated: {INDEX_FILE}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
