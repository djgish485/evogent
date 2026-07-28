#!/data/data/com.termux/files/usr/bin/env python3
"""Private, benchmark-gated model routing for the phone runtime.

The public file describes mechanics and safe fallbacks.  A deployment may write
``data/model-routing.json`` with a candidate route, but a routine route is used
only when the phone-local receipt ledger proves enough recent paired passes.
Receipts contain metrics and digests, never source text or model output.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import stat
import time
import unicodedata
from pathlib import Path
from typing import Any, Iterable


SCHEMA_VERSION = 1
ALLOWED_EFFORTS = frozenset({"low", "medium", "high", "xhigh", "max", "ultra"})
SAFE_TOKEN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,159}$")


def _read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _read_private_json(path: Path) -> dict[str, Any]:
    try:
        info = path.stat()
    except OSError:
        return {}
    if (
        not stat.S_ISREG(info.st_mode)
        or stat.S_IMODE(info.st_mode) != 0o600
        or info.st_size <= 0
        or info.st_size > 49_152
    ):
        return {}
    return _read_json(path)


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return rows
    for line in lines:
        try:
            value = json.loads(line)
        except ValueError:
            continue
        if isinstance(value, dict) and value.get("schemaVersion") == SCHEMA_VERSION:
            rows.append(value)
    return rows


def _read_private_jsonl(path: Path) -> list[dict[str, Any]]:
    try:
        info = path.stat()
    except OSError:
        return []
    if (
        not stat.S_ISREG(info.st_mode)
        or stat.S_IMODE(info.st_mode) != 0o600
        or info.st_size <= 0
        or info.st_size > 8 * 1024 * 1024
    ):
        return []
    return _read_jsonl(path)


def _markdown_sections(path: Path) -> dict[str, str]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return {}
    sections: dict[str, str] = {}
    heading = ""
    for line in lines:
        match = re.match(r"^##\s+(.+?)\s*$", line)
        if match:
            heading = match.group(1).strip().lower()
            continue
        if heading and line.strip() and heading not in sections:
            sections[heading] = re.sub(r"^[-*]\s*", "", line.strip())
    return sections


def _safe_model(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    normalized = value.strip()
    return normalized if SAFE_TOKEN.fullmatch(normalized) else ""


def _safe_effort(value: Any, fallback: str = "medium") -> str:
    normalized = value.strip().lower() if isinstance(value, str) else ""
    return normalized if normalized in ALLOWED_EFFORTS else fallback


def _allowed_efforts(route: dict[str, Any]) -> set[str]:
    values = route.get("allowedEfforts")
    if not isinstance(values, list):
        return set(ALLOWED_EFFORTS)
    allowed = {
        value.strip().lower()
        for value in values
        if isinstance(value, str) and value.strip().lower() in ALLOWED_EFFORTS
    }
    return allowed or set(ALLOWED_EFFORTS)


def _positive_int(value: Any, fallback: int) -> int:
    if isinstance(value, bool):
        return fallback
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return fallback
    return parsed if parsed > 0 else fallback


def _finite_nonnegative(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) and parsed >= 0 else None


def live_route_file_valid(
    path: Path,
    *,
    policy_path: Path,
    allow_missing: bool = False,
) -> bool:
    """Validate the bounded private route artifact without exposing its contents."""

    try:
        info = path.stat()
    except OSError:
        return allow_missing
    if (
        not stat.S_ISREG(info.st_mode)
        or stat.S_IMODE(info.st_mode) != 0o600
        or info.st_size <= 0
        or info.st_size > 49_152
    ):
        return False
    value = _read_json(path)
    routes = value.get("routes")
    if value.get("schemaVersion") != SCHEMA_VERSION or not isinstance(routes, dict):
        return False
    if len(routes) > 32:
        return False
    policy_routes = (_read_json(policy_path).get("routes") or {})
    for task, entry in routes.items():
        if not isinstance(task, str) or not SAFE_TOKEN.fullmatch(task):
            return False
        if not isinstance(entry, dict):
            return False
        route_policy = policy_routes.get(task)
        allowed_efforts = (
            _allowed_efforts(route_policy)
            if isinstance(route_policy, dict)
            else set(ALLOWED_EFFORTS)
        )
        if not _safe_model(entry.get("model")):
            return False
        effort = entry.get("effort")
        if not isinstance(effort, str) or effort.strip().lower() not in allowed_efforts:
            return False
        qualification = entry.get("qualification")
        if qualification is not None:
            if not isinstance(qualification, dict):
                return False
            suite_id = qualification.get("suiteId")
            if not isinstance(suite_id, str) or not SAFE_TOKEN.fullmatch(suite_id):
                return False
    return True


def _route_defaults(
    task: str,
    *,
    config_path: Path,
    policy_path: Path,
) -> dict[str, Any]:
    policy = _read_json(policy_path)
    route = (policy.get("routes") or {}).get(task)
    if not isinstance(route, dict):
        return {"execution": "unsupported", "model": "", "effort": "", "origin": "missing"}
    execution = route.get("execution")
    if execution != "agent":
        return {"execution": execution or "unsupported", "model": "", "effort": "", "origin": "policy"}

    sections = _markdown_sections(config_path)
    model = ""
    for name in route.get("modelSections") or []:
        if isinstance(name, str):
            model = _safe_model(sections.get(name.strip().lower()))
            if model:
                break
    origin = "config" if model else "policy"
    model = model or _safe_model(route.get("fallbackModel"))

    allowed_efforts = _allowed_efforts(route)
    effort = ""
    for name in route.get("effortSections") or []:
        if isinstance(name, str):
            candidate = sections.get(name.strip().lower())
            if isinstance(candidate, str) and candidate.strip().lower() in allowed_efforts:
                effort = candidate.strip().lower()
                break
    fallback_effort = _safe_effort(route.get("fallbackEffort"))
    effort = effort or (fallback_effort if fallback_effort in allowed_efforts else sorted(allowed_efforts)[0])
    return {
        "execution": "agent",
        "model": model,
        "effort": effort,
        "origin": origin,
        "policy": policy,
        "routePolicy": route,
    }


def _receipt_key(row: dict[str, Any]) -> tuple[str, str]:
    return (_safe_model(row.get("model")), _safe_effort(row.get("effort"), ""))


def qualification_decision(
    receipts: Iterable[dict[str, Any]],
    *,
    task: str,
    suite_id: str,
    candidate_model: str,
    candidate_effort: str,
    baseline_model: str,
    baseline_effort: str,
    minimum_paired_passes: int,
    max_age_hours: int,
    now_ms: int | None = None,
) -> dict[str, Any]:
    """Prove a candidate matched a passing baseline on paired private cases.

    Mechanics failures invalidate their pair but never become model-quality
    failures.  A candidate qualifies only from distinct rounds where both routes
    passed mechanics and quality on the same benchmark task and suite.
    """

    now_ms = int(time.time() * 1000) if now_ms is None else int(now_ms)
    cutoff_ms = now_ms - max_age_hours * 60 * 60 * 1000
    wanted_candidate = (_safe_model(candidate_model), _safe_effort(candidate_effort, ""))
    wanted_baseline = (_safe_model(baseline_model), _safe_effort(baseline_effort, ""))
    if not all((*wanted_candidate, *wanted_baseline)) or not SAFE_TOKEN.fullmatch(suite_id):
        return {"qualified": False, "reason": "invalid_request", "pairedPasses": 0}

    by_round: dict[int, dict[str, dict[str, Any]]] = {}
    mechanics_failures = 0
    for row in receipts:
        if row.get("task") != task or row.get("suiteId") != suite_id:
            continue
        recorded_at = _finite_nonnegative(row.get("recordedAtMs"))
        if recorded_at is None or recorded_at < cutoff_ms or recorded_at > now_ms + 300_000:
            continue
        try:
            round_number = int(row.get("round"))
        except (TypeError, ValueError):
            continue
        if round_number < 1:
            continue
        key = _receipt_key(row)
        role = "candidate" if key == wanted_candidate else "baseline" if key == wanted_baseline else ""
        if not role:
            continue
        by_round.setdefault(round_number, {})[role] = row

    paired_passes = 0
    elapsed_ratios: list[float] = []
    for pair in by_round.values():
        baseline = pair.get("baseline")
        candidate = pair.get("candidate")
        if not baseline or not candidate:
            continue
        if (
            baseline.get("mechanicsStatus") != "passed"
            or candidate.get("mechanicsStatus") != "passed"
        ):
            mechanics_failures += 1
            continue
        if (
            baseline.get("qualityStatus") != "passed"
            or candidate.get("qualityStatus") != "passed"
        ):
            continue
        paired_passes += 1
        baseline_elapsed = _finite_nonnegative((baseline.get("metrics") or {}).get("elapsedMs"))
        candidate_elapsed = _finite_nonnegative((candidate.get("metrics") or {}).get("elapsedMs"))
        if baseline_elapsed and candidate_elapsed is not None:
            elapsed_ratios.append(candidate_elapsed / baseline_elapsed)

    qualified = mechanics_failures == 0 and paired_passes >= minimum_paired_passes
    decision: dict[str, Any] = {
        "qualified": qualified,
        "reason": "qualified" if qualified else (
            "mechanics_failure" if mechanics_failures else "insufficient_paired_quality_passes"
        ),
        "pairedPasses": paired_passes,
        "minimumPairedPasses": minimum_paired_passes,
        "mechanicsFailedPairs": mechanics_failures,
    }
    if elapsed_ratios:
        decision["meanElapsedRatio"] = sum(elapsed_ratios) / len(elapsed_ratios)
    return decision


def resolve_route(
    task: str,
    *,
    config_path: Path,
    policy_path: Path,
    live_path: Path,
    receipts_path: Path,
    model_override: str = "",
    effort_override: str = "",
    now_ms: int | None = None,
) -> dict[str, Any]:
    baseline = _route_defaults(task, config_path=config_path, policy_path=policy_path)
    if baseline.get("execution") != "agent":
        return baseline

    explicit_model = _safe_model(model_override)
    allowed_efforts = _allowed_efforts(baseline.get("routePolicy") or {})
    explicit_effort = _safe_effort(effort_override, "") if effort_override else ""
    if explicit_effort not in allowed_efforts:
        explicit_effort = ""
    if explicit_model or explicit_effort:
        return {
            **baseline,
            "model": explicit_model or baseline["model"],
            "effort": explicit_effort or baseline["effort"],
            "origin": "environment",
        }

    live = _read_private_json(live_path)
    entry = (live.get("routes") or {}).get(task)
    if not isinstance(entry, dict):
        return baseline
    route_policy = baseline.get("routePolicy") or {}
    if route_policy.get("persistentOverrideAllowed") is False:
        return {**baseline, "origin": "baseline_persistent_override_disabled"}
    candidate_model = _safe_model(entry.get("model"))
    candidate_effort = _safe_effort(entry.get("effort"), "")
    if not candidate_model or candidate_effort not in allowed_efforts:
        return {**baseline, "origin": "baseline_invalid_live"}
    if candidate_model == baseline["model"] and candidate_effort == baseline["effort"]:
        return {**baseline, "origin": "live_matches_baseline"}

    if route_policy.get("qualificationRequired") is not True:
        return {**baseline, "model": candidate_model, "effort": candidate_effort, "origin": "live"}

    qualification = entry.get("qualification")
    suite_id = qualification.get("suiteId") if isinstance(qualification, dict) else ""
    policy = baseline.get("policy") or {}
    decision = qualification_decision(
        _read_private_jsonl(receipts_path),
        task=task,
        suite_id=suite_id if isinstance(suite_id, str) else "",
        candidate_model=candidate_model,
        candidate_effort=candidate_effort,
        baseline_model=baseline["model"],
        baseline_effort=baseline["effort"],
        minimum_paired_passes=_positive_int(policy.get("minimumPairedPasses"), 3),
        max_age_hours=_positive_int(policy.get("qualificationMaxAgeHours"), 720),
        now_ms=now_ms,
    )
    if decision["qualified"]:
        return {
            **baseline,
            "model": candidate_model,
            "effort": candidate_effort,
            "origin": "benchmark_qualified_live",
            "qualification": decision,
        }
    return {**baseline, "origin": f"baseline_{decision['reason']}", "qualification": decision}


def _normalize_text(value: str) -> str:
    value = unicodedata.normalize("NFKC", value).casefold()
    return " ".join(re.sub(r"[^\w]+", " ", value, flags=re.UNICODE).split())


def grounded_title_metrics(response_text: str, tree_text: str) -> dict[str, Any]:
    candidates = re.findall(r'\{"titles"\s*:\s*\[[^\]]*\]\}', response_text, flags=re.DOTALL)
    try:
        payload = json.loads(candidates[-1]) if candidates else {}
    except ValueError:
        payload = {}
    titles = payload.get("titles") if isinstance(payload, dict) else []
    titles = titles if isinstance(titles, list) else []
    valid = [
        title.strip()
        for title in titles
        if isinstance(title, str) and len(_normalize_text(title)) >= 4
    ]
    normalized_tree = _normalize_text(tree_text)
    grounded = sum(1 for title in valid if _normalize_text(title) in normalized_tree)
    mechanics_status = "passed" if len(normalized_tree) >= 40 else "failed"
    quality_status = (
        "passed"
        if mechanics_status == "passed" and len(valid) == 5 and grounded == 5
        else "failed" if mechanics_status == "passed" else "not_scored"
    )
    return {
        "mechanicsStatus": mechanics_status,
        "qualityStatus": quality_status,
        "metrics": {
            "reportedTitles": len(valid),
            "groundedTitles": grounded,
            "requiredTitles": 5,
            "caseDigest": hashlib.sha256(tree_text.encode("utf-8")).hexdigest(),
        },
    }


def append_receipt(path: Path, receipt: dict[str, Any]) -> None:
    safe = {
        "schemaVersion": SCHEMA_VERSION,
        "recordedAtMs": int(receipt.get("recordedAtMs") or time.time() * 1000),
        "suiteId": str(receipt.get("suiteId") or "")[:160],
        "round": int(receipt.get("round") or 0),
        "task": str(receipt.get("task") or "")[:80],
        "role": "baseline" if receipt.get("role") == "baseline" else "candidate",
        "model": _safe_model(receipt.get("model")),
        "effort": _safe_effort(receipt.get("effort"), ""),
        "mechanicsStatus": str(receipt.get("mechanicsStatus") or "failed")[:40],
        "qualityStatus": str(receipt.get("qualityStatus") or "not_scored")[:40],
        "metrics": {},
    }
    metrics = receipt.get("metrics")
    if isinstance(metrics, dict):
        for key, value in metrics.items():
            if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9]*", key):
                continue
            if isinstance(value, bool) or isinstance(value, (int, float)) and math.isfinite(float(value)):
                safe["metrics"][key] = value
            elif key.endswith("Digest") and isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value):
                safe["metrics"][key] = value
    if (
        not SAFE_TOKEN.fullmatch(safe["suiteId"])
        or safe["round"] < 1
        or not SAFE_TOKEN.fullmatch(safe["task"])
        or not safe["model"]
        or not safe["effort"]
    ):
        raise ValueError("invalid benchmark receipt identity")
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    try:
        os.fchmod(descriptor, stat.S_IRUSR | stat.S_IWUSR)
        os.write(descriptor, (json.dumps(safe, separators=(",", ":")) + "\n").encode("utf-8"))
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)

    resolve = sub.add_parser("resolve")
    resolve.add_argument("--task", required=True)
    resolve.add_argument("--config", required=True)
    resolve.add_argument("--policy", required=True)
    resolve.add_argument("--live", required=True)
    resolve.add_argument("--receipts", required=True)
    resolve.add_argument("--model-override", default="")
    resolve.add_argument("--effort-override", default="")
    resolve.add_argument("--now-ms", type=int)
    resolve.add_argument("--json", action="store_true")

    grounded = sub.add_parser("grounded-titles")
    grounded.add_argument("--response", required=True)
    grounded.add_argument("--tree", required=True)

    record = sub.add_parser("record")
    record.add_argument("--ledger", required=True)
    record.add_argument("--receipt-json", required=True)

    validate = sub.add_parser("validate-live")
    validate.add_argument("--live", required=True)
    validate.add_argument("--policy", required=True)
    validate.add_argument("--allow-missing", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "resolve":
        result = resolve_route(
            args.task,
            config_path=Path(args.config),
            policy_path=Path(args.policy),
            live_path=Path(args.live),
            receipts_path=Path(args.receipts),
            model_override=args.model_override,
            effort_override=args.effort_override,
            now_ms=args.now_ms,
        )
        if args.json:
            print(json.dumps(result, separators=(",", ":")))
        elif result.get("execution") == "agent":
            print(f"{result['model']}\t{result['effort']}\t{result['origin']}")
        else:
            print(f"-\t-\t{result.get('execution', 'unsupported')}")
        return 0
    if args.command == "grounded-titles":
        result = grounded_title_metrics(
            Path(args.response).read_text(encoding="utf-8", errors="replace"),
            Path(args.tree).read_text(encoding="utf-8", errors="replace"),
        )
        print(json.dumps(result, separators=(",", ":")))
        return 0
    if args.command == "validate-live":
        return 0 if live_route_file_valid(
            Path(args.live),
            policy_path=Path(args.policy),
            allow_missing=args.allow_missing,
        ) else 1
    receipt = json.loads(args.receipt_json)
    if not isinstance(receipt, dict):
        raise ValueError("receipt must be an object")
    append_receipt(Path(args.ledger), receipt)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
