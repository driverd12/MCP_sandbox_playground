#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

python3 - "$repo_root" <<'PY'
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Tuple


def compact_single_line(text: str, limit: int = 220) -> str:
    collapsed = " ".join(str(text).split())
    if len(collapsed) <= limit:
        return collapsed
    if limit <= 3:
        return collapsed[:limit]
    return collapsed[: limit - 3] + "..."


def resolve_bridge(repo_root: Path) -> Path:
    candidates = [
        repo_root / "bridges" / "local-imprint_bridge.py",
        repo_root / "bridges" / "local_imprint_bridge.py",
    ]
    for path in candidates:
        if path.exists():
            return path
    raise FileNotFoundError("local-imprint bridge not found in ./bridges")


def extract_content(stdout_text: str) -> str:
    raw = stdout_text.strip()
    if not raw:
        return ""
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return raw
    if isinstance(parsed, dict):
        content = parsed.get("content")
        if isinstance(content, str):
            return content.strip()
    return raw


def passes_expected(content: str, expected: str) -> bool:
    value = content.strip()
    if value == expected:
        return True
    collapsed = value.lower()
    return f"answer: {expected}".lower() in collapsed or f"= {expected}" in collapsed


def run_case(python_bin: str, bridge_path: Path, repo_root: Path, prompt: str, expected: str) -> Dict[str, Any]:
    payload = {
        "agent_id": "local-imprint",
        "thread_id": f"trichat-imprint-math-smoke-{int(time.time())}",
        "prompt": prompt,
        "history": [],
        "bootstrap_text": "",
        "peer_context": "",
        "workspace": str(repo_root),
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    proc = subprocess.run(
        [python_bin, str(bridge_path)],
        input=json.dumps(payload, ensure_ascii=True),
        capture_output=True,
        text=True,
        check=False,
        cwd=str(repo_root),
    )
    content = extract_content(proc.stdout or "")
    return {
        "prompt": prompt,
        "expected": expected,
        "returncode": proc.returncode,
        "content": content,
        "stderr": compact_single_line(proc.stderr or "", 300),
        "ok": proc.returncode == 0 and passes_expected(content, expected),
    }


def main() -> int:
    repo_root = Path(sys.argv[1]).resolve()
    bridge_path = resolve_bridge(repo_root)
    python_bin = (os.environ.get("TRICHAT_BRIDGE_PYTHON") or sys.executable or "python3").strip() or "python3"

    cases: List[Tuple[str, str]] = [
        ("What is 2+2?", "4"),
        ("Evaluate 2 + 3 * 4", "14"),
        ("Evaluate (2 + 3) * 4", "20"),
        ("What is 20 / 5 + 1?", "5"),
    ]

    results = [run_case(python_bin, bridge_path, repo_root, prompt, expected) for prompt, expected in cases]
    failures = [item for item in results if not item["ok"]]

    payload = {
        "ok": len(failures) == 0,
        "bridge": str(bridge_path),
        "python": python_bin,
        "total_cases": len(results),
        "passed_cases": len(results) - len(failures),
        "failed_cases": len(failures),
        "results": results,
    }
    print(json.dumps(payload, indent=2))
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
PY
