#!/usr/bin/env python3
"""TriChat command adapter wrapper for local-imprint.

Primary behavior:
- deterministically solve arithmetic prompts (PEMDAS-safe) when detected
- otherwise call local Ollama chat API for normal reasoning
"""

from __future__ import annotations

import argparse
import ast
import json
import os
import re
import sys
import urllib.error
import urllib.request
from decimal import Decimal, InvalidOperation, getcontext
from fractions import Fraction
from pathlib import Path
from typing import Any, Dict, List, Optional

from common import (
    BridgeError,
    build_prompt,
    compact_single_line,
    emit_content,
    emit_status,
    parse_bool_env,
    parse_int_env,
    publish_bus_event,
    read_payload,
)

DEFAULT_OLLAMA_API_BASE = "http://127.0.0.1:11434"
DEFAULT_IMPRINT_MODEL = "llama3.2:3b"
DEFAULT_IMPRINT_SYSTEM_PROMPT = (
    "You are local-imprint for TriChat. Give concise, direct answers. "
    "For arithmetic, apply order of operations exactly and provide the correct final value."
)

MATH_ALLOWED_CHARS_RE = re.compile(r"^[0-9\.\+\-\*\/%\(\)\s\^xX×÷]+$")
MATH_INLINE_RE = re.compile(r"`([^`]+)`")
MATH_PREFIX_RE = re.compile(
    r"(?i)\b(?:what is|what's|calculate|compute|evaluate|solve|simplify)\b\s*(.+)"
)
MATH_STEP_HINT_RE = re.compile(r"(?i)\b(show|steps?|order of operations|pemdas|bedmas)\b")


def parse_args(argv: List[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Local-imprint bridge wrapper for TriChat")
    parser.add_argument("--self-test", action="store_true", help="Validate bridge behavior and local dependencies.")
    parser.add_argument("--bridge-name", default="local-imprint", help=argparse.SUPPRESS)
    return parser.parse_args(argv)


def ollama_api_base() -> str:
    return (os.environ.get("TRICHAT_OLLAMA_API_BASE") or DEFAULT_OLLAMA_API_BASE).strip() or DEFAULT_OLLAMA_API_BASE


def local_imprint_model() -> str:
    model = (os.environ.get("TRICHAT_IMPRINT_MODEL") or os.environ.get("TRICHAT_OLLAMA_MODEL") or DEFAULT_IMPRINT_MODEL).strip()
    return model or DEFAULT_IMPRINT_MODEL


def local_imprint_system_prompt() -> str:
    prompt = (os.environ.get("TRICHAT_IMPRINT_SYSTEM_PROMPT") or DEFAULT_IMPRINT_SYSTEM_PROMPT).strip()
    return prompt or DEFAULT_IMPRINT_SYSTEM_PROMPT


def parse_temperature_env(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        value = float(raw.strip())
    except ValueError:
        return default
    return max(0.0, min(value, 1.0))


def normalize_math_expression(raw: str) -> Optional[str]:
    candidate = str(raw or "").strip()
    if not candidate:
        return None

    candidate = candidate.split("\n", 1)[0].strip()
    candidate = candidate.split("=", 1)[0].strip()
    candidate = candidate.strip(" \t\r\n,.;:!?")
    candidate = candidate.replace("×", "*").replace("÷", "/")
    candidate = re.sub(r"(?<=\d)\s*[xX]\s*(?=\d)", "*", candidate)
    candidate = candidate.replace("^", "**")
    candidate = candidate.replace(",", "")
    candidate = re.sub(r"\s+", " ", candidate).strip()
    if not candidate:
        return None
    if not MATH_ALLOWED_CHARS_RE.match(candidate):
        return None
    if not re.search(r"\d", candidate):
        return None
    return candidate


def extract_math_expression(prompt: str) -> Optional[str]:
    text = str(prompt or "").strip()
    if not text:
        return None

    candidates: List[str] = []
    for match in MATH_INLINE_RE.finditer(text):
        candidates.append(match.group(1))

    prefix_match = MATH_PREFIX_RE.search(text)
    if prefix_match:
        candidates.append(prefix_match.group(1))

    candidates.append(text)
    for candidate in candidates:
        normalized = normalize_math_expression(candidate)
        if normalized:
            return normalized
    return None


def fraction_from_number(value: Any) -> Fraction:
    if isinstance(value, bool):
        raise BridgeError("boolean values are not valid math operands")
    if isinstance(value, int):
        return Fraction(value, 1)
    if isinstance(value, float):
        if value != value or value in (float("inf"), float("-inf")):
            raise BridgeError("invalid floating-point value")
        return Fraction(Decimal(str(value)))
    if isinstance(value, str):
        try:
            return Fraction(Decimal(value))
        except (InvalidOperation, ZeroDivisionError) as error:
            raise BridgeError(f"invalid numeric literal: {value}") from error
    raise BridgeError(f"unsupported numeric type: {type(value).__name__}")


def evaluate_math_ast(node: ast.AST) -> Fraction:
    if isinstance(node, ast.Expression):
        return evaluate_math_ast(node.body)

    if isinstance(node, ast.Constant):
        return fraction_from_number(node.value)

    if isinstance(node, ast.UnaryOp):
        value = evaluate_math_ast(node.operand)
        if isinstance(node.op, ast.UAdd):
            return value
        if isinstance(node.op, ast.USub):
            return -value
        raise BridgeError("unsupported unary operator")

    if isinstance(node, ast.BinOp):
        left = evaluate_math_ast(node.left)
        right = evaluate_math_ast(node.right)
        if isinstance(node.op, ast.Add):
            return left + right
        if isinstance(node.op, ast.Sub):
            return left - right
        if isinstance(node.op, ast.Mult):
            return left * right
        if isinstance(node.op, ast.Div):
            if right == 0:
                raise BridgeError("division by zero")
            return left / right
        if isinstance(node.op, ast.FloorDiv):
            if right == 0:
                raise BridgeError("division by zero")
            return Fraction(left.numerator * right.denominator // (left.denominator * right.numerator), 1)
        if isinstance(node.op, ast.Mod):
            if right == 0:
                raise BridgeError("modulo by zero")
            numerator = left.numerator * right.denominator
            denominator = left.denominator * right.numerator
            return Fraction(numerator % denominator, right.denominator * left.denominator)
        if isinstance(node.op, ast.Pow):
            if right.denominator != 1:
                raise BridgeError("fractional exponents are not supported")
            exponent = int(right.numerator)
            if abs(exponent) > 18:
                raise BridgeError("exponent too large")
            if left == 0 and exponent < 0:
                raise BridgeError("zero cannot be raised to a negative power")
            return left ** exponent
        raise BridgeError("unsupported binary operator")

    raise BridgeError(f"unsupported expression node: {type(node).__name__}")


def evaluate_math_expression(expression: str) -> Fraction:
    try:
        parsed = ast.parse(expression, mode="eval")
    except SyntaxError as error:
        raise BridgeError(f"invalid math expression: {error.msg}") from error
    return evaluate_math_ast(parsed)


def format_fraction(value: Fraction) -> str:
    if value.denominator == 1:
        return str(value.numerator)
    precision = parse_int_env("TRICHAT_IMPRINT_MATH_DECIMAL_PLACES", 12, minimum=3, maximum=30)
    getcontext().prec = max(precision + 8, 24)
    decimal_value = Decimal(value.numerator) / Decimal(value.denominator)
    text = format(decimal_value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    if not text:
        text = "0"
    return text


def should_show_math_steps(prompt: str) -> bool:
    return bool(MATH_STEP_HINT_RE.search(prompt or ""))


def solve_math_prompt(prompt: str) -> Optional[Dict[str, Any]]:
    if not parse_bool_env("TRICHAT_IMPRINT_MATH_ASSIST", True):
        return None
    expression = extract_math_expression(prompt)
    if not expression:
        return None
    result = evaluate_math_expression(expression)
    formatted = format_fraction(result)
    if should_show_math_steps(prompt):
        content = f"Order of operations: {expression} = {formatted}\nAnswer: {formatted}"
    else:
        content = formatted
    return {
        "content": content,
        "expression": expression,
        "result": formatted,
    }


def ollama_request(endpoint: str, payload: Dict[str, Any], timeout_seconds: int) -> Dict[str, Any]:
    body = json.dumps(payload, ensure_ascii=True).encode("utf-8")
    req = urllib.request.Request(
        url=f"{ollama_api_base()}{endpoint}",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=max(1, int(timeout_seconds))) as response:
            raw = response.read().decode("utf-8", errors="replace")
    except TimeoutError as error:
        raise BridgeError(f"ollama request timed out on {endpoint}") from error
    except urllib.error.URLError as error:
        raise BridgeError(f"ollama request failed on {endpoint}: {error}") from error
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as error:
        raise BridgeError(f"ollama returned invalid JSON: {error}") from error
    if not isinstance(parsed, dict):
        raise BridgeError(f"ollama returned unexpected payload type: {type(parsed).__name__}")
    return parsed


def ollama_chat(prompt: str, *, timeout_seconds: int) -> str:
    system_prompt = local_imprint_system_prompt()
    model = local_imprint_model()
    temperature = parse_temperature_env("TRICHAT_IMPRINT_TEMPERATURE", 0.15)
    payload = {
        "model": model,
        "stream": False,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": prompt},
        ],
        "options": {"temperature": temperature},
    }
    response = ollama_request("/api/chat", payload, timeout_seconds=timeout_seconds)
    message = response.get("message", {}) if isinstance(response, dict) else {}
    content = message.get("content")
    if not isinstance(content, str) or not content.strip():
        raise BridgeError("ollama returned empty response content")
    return content.strip()


def check_ollama_status(timeout_seconds: int) -> Dict[str, Any]:
    req = urllib.request.Request(
        url=f"{ollama_api_base()}/api/tags",
        headers={"Content-Type": "application/json"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=max(1, timeout_seconds)) as response:
            raw = response.read().decode("utf-8", errors="replace")
    except Exception as error:  # noqa: BLE001
        return {
            "reachable": False,
            "error": compact_single_line(str(error), 220),
            "model": local_imprint_model(),
        }
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        parsed = {}
    models = parsed.get("models", []) if isinstance(parsed, dict) else []
    names = []
    if isinstance(models, list):
        for model in models:
            if isinstance(model, dict):
                name = model.get("name")
                if isinstance(name, str) and name.strip():
                    names.append(name.strip())
    return {
        "reachable": True,
        "model": local_imprint_model(),
        "models_detected": names[:8],
    }


def run_self_test() -> int:
    cases = [
        ("2+2", "4"),
        ("2 + 3 * 4", "14"),
        ("(2 + 3) * 4", "20"),
        ("18 / 3 + 2", "8"),
    ]
    failures: List[str] = []
    for expression, expected in cases:
        try:
            actual = format_fraction(evaluate_math_expression(expression))
        except Exception as error:  # noqa: BLE001
            failures.append(f"{expression} -> error={error}")
            continue
        if actual != expected:
            failures.append(f"{expression} -> expected={expected} actual={actual}")

    ollama_status = check_ollama_status(timeout_seconds=2)
    payload: Dict[str, Any] = {
        "bridge": "local-imprint",
        "wrapper": str(Path(__file__).resolve()),
        "math_assist_enabled": parse_bool_env("TRICHAT_IMPRINT_MATH_ASSIST", True),
        "math_eval_ok": len(failures) == 0,
        "math_eval_failures": failures,
        "ollama": ollama_status,
    }
    emit_status(payload)
    return 0 if not failures else 1


def run_adapter() -> int:
    payload = read_payload()
    thread_id = str(payload.get("thread_id") or "").strip()
    bus_enabled = parse_bool_env("TRICHAT_BRIDGE_BUS_EVENTS", True) and bool(thread_id)
    bus_warn = parse_bool_env("TRICHAT_BRIDGE_BUS_WARN", False)

    def emit_bus(event_type: str, *, content: str = "", metadata: Dict[str, Any] | None = None) -> None:
        if not bus_enabled:
            return
        try:
            publish_bus_event(
                thread_id=thread_id,
                event_type=event_type,
                source_agent="local-imprint",
                source_client="bridge.local-imprint",
                role="system",
                content=content,
                metadata=metadata,
            )
        except BridgeError as error:
            if bus_warn:
                print(f"[local-imprint-bridge] bus publish skipped: {error}", file=sys.stderr)

    if parse_bool_env("TRICHAT_BRIDGE_DRY_RUN", False):
        prompt = str(payload.get("prompt") or "").strip() or "(empty prompt)"
        emit_content(
            f"[dry-run] local-imprint bridge received prompt: {compact_single_line(prompt, 160)}",
            meta={"adapter": "local-imprint-bridge", "dry_run": True},
        )
        emit_bus(
            "adapter.turn.dry_run",
            content=compact_single_line(prompt, 180),
            metadata={"adapter": "local-imprint-bridge"},
        )
        return 0

    prompt = str(payload.get("prompt") or "").strip()
    timeout_seconds = parse_int_env("TRICHAT_IMPRINT_TIMEOUT", 75, minimum=5, maximum=7200)
    max_chars = parse_int_env("TRICHAT_BRIDGE_MAX_CHARS", 12000, minimum=500, maximum=200000)
    bridge_prompt = build_prompt(payload, bridge_name="local-imprint")

    emit_bus(
        "adapter.turn.started",
        content=f"local-imprint start (model={local_imprint_model()})",
        metadata={
            "adapter": "local-imprint-bridge",
            "model": local_imprint_model(),
            "timeout_seconds": timeout_seconds,
        },
    )

    try:
        math_result = solve_math_prompt(prompt)
        if math_result is not None:
            content = str(math_result["content"]).strip()
            emit_content(
                content,
                meta={
                    "adapter": "local-imprint-bridge",
                    "strategy": "deterministic-math",
                    "expression": math_result["expression"],
                    "result": math_result["result"],
                },
                max_chars=max_chars,
            )
            emit_bus(
                "adapter.turn.succeeded",
                content=f"deterministic math: {math_result['expression']} = {math_result['result']}",
                metadata={
                    "adapter": "local-imprint-bridge",
                    "strategy": "deterministic-math",
                    "model": local_imprint_model(),
                    "timeout_seconds": timeout_seconds,
                },
            )
            return 0

        content = ollama_chat(bridge_prompt, timeout_seconds=timeout_seconds)
        emit_content(
            content,
            meta={
                "adapter": "local-imprint-bridge",
                "strategy": "ollama",
                "model": local_imprint_model(),
                "timeout_seconds": timeout_seconds,
            },
            max_chars=max_chars,
        )
        emit_bus(
            "adapter.turn.succeeded",
            content=compact_single_line(content, 220),
            metadata={
                "adapter": "local-imprint-bridge",
                "strategy": "ollama",
                "model": local_imprint_model(),
                "timeout_seconds": timeout_seconds,
                "output_chars": len(content),
            },
        )
        return 0
    except BridgeError as error:
        error_text = compact_single_line(str(error), 320)
        emit_bus(
            "adapter.turn.failed",
            content=error_text,
            metadata={
                "adapter": "local-imprint-bridge",
                "model": local_imprint_model(),
                "timeout_seconds": timeout_seconds,
                "error": error_text,
            },
        )
        raise


def main(argv: List[str]) -> int:
    args = parse_args(argv)
    if args.self_test:
        return run_self_test()

    try:
        return run_adapter()
    except BridgeError as error:
        print(str(error), file=sys.stderr)
        return 1
    except Exception as error:  # noqa: BLE001
        print(f"unexpected local-imprint bridge error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
