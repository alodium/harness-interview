#!/usr/bin/env python3
"""
Phase 1: Data Validation Gate for Agent Forensics (MVP).

1. Fetches SWE-agent trajectories from Hugging Face Datasets Server API
   starting at:
   https://datasets-server.huggingface.co/rows?dataset=nebius/SWE-agent-trajectories&config=default&split=train&offset=0&length=15
2. Filters for 5 failed sessions (target == False) with a non-empty generated_patch
   (or model_patch) and at least 8 agent steps (deduplicating by instance_id across
   15-row pages by default so all 5 candidates test distinct bugs).
3. Cross-references each instance_id against princeton-nlp/SWE-bench_Verified
   (with fallback to nebius/SWE-bench-extra and princeton-nlp/SWE-bench) via HF API
   to fetch problem_statement and gold patch.
4. Sends a compacted version of each trajectory + broken patch + gold patch to
   Anthropic Claude (via ANTHROPIC_API_KEY) — or accepts pre-reviewed analyses via
   --analyses-file when running offline — to extract strict JSON exam metadata.
5. Writes private_data/raw_candidates.json and DATA_QA.md for human review.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

ROOT_DIR = Path(__file__).resolve().parent.parent
RAW_CANDIDATES_PATH = ROOT_DIR / "private_data" / "raw_candidates.json"
DATA_QA_PATH = ROOT_DIR / "DATA_QA.md"

TRAJ_DATASET = "nebius/SWE-agent-trajectories"
PRIMARY_TRAJ_URL = (
    "https://datasets-server.huggingface.co/rows"
    "?dataset=nebius/SWE-agent-trajectories&config=default&split=train&offset=0&length=15"
)

BENCHMARK_SOURCES = [
    ("princeton-nlp/SWE-bench_Verified", "default", "test"),
    ("nebius/SWE-bench-extra", "default", "train"),
]

VALID_FAILURE_TYPES = {
    "test_tampering",
    "hallucination",
    "band_aid_fix",
    "context_loop",
    "misread_issue",
}

DEFAULT_CLAUDE_MODELS = [
    "claude-sonnet-4-20250514",
    "claude-3-7-sonnet-latest",
    "claude-3-5-sonnet-latest",
]


def load_dotenv_files() -> None:
    """Load .env and .env.local from project root without external dependencies."""
    for filename in (".env", ".env.local"):
        env_path = ROOT_DIR / filename
        if not env_path.is_file():
            continue
        for raw_line in env_path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            if line.startswith("export "):
                line = line[len("export ") :].strip()
            key, val = line.split("=", 1)
            key = key.strip()
            val = val.strip().strip("'").strip('"')
            if key and key not in os.environ:
                os.environ[key] = val


def http_get_json(url: str, retries: int = 3, timeout: int = 35) -> dict[str, Any]:
    """GET JSON from Hugging Face Datasets Server with simple backoff."""
    last_err: Exception | None = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(
                url,
                headers={"User-Agent": "HarnessInterview-DataValidator/1.0"},
            )
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as err:
            last_err = err
            if err.code in (429, 500, 502, 503, 504) and attempt < retries - 1:
                time.sleep(2.0 * (attempt + 1))
                continue
            raise
        except Exception as err:
            last_err = err
            if attempt < retries - 1:
                time.sleep(1.5 * (attempt + 1))
                continue
            raise
    raise RuntimeError(f"Failed GET {url}: {last_err}")


def split_thought_and_action(text: str) -> tuple[str, str]:
    """Extract the SWE-agent command block (last fenced code block) and thought."""
    fenced_matches = list(re.finditer(r"```(?:[a-zA-Z0-9_+-]*)\n([\s\S]*?)```", text))
    if fenced_matches:
        last_match = fenced_matches[-1]
        action = last_match.group(1).strip()
        thought = (text[: last_match.start()] + text[last_match.end() :]).strip()
        return (thought or "(Executed command)", action or "(Empty command)")

    tag_match = re.search(r"<(?:action|command)>([\s\S]*?)</(?:action|command)>", text, re.I)
    if tag_match:
        action = tag_match.group(1).strip()
        thought = (text[: tag_match.start()] + text[tag_match.end() :]).strip()
        return (thought or "(Executed command)", action or "(Empty command)")

    return (text.strip() or "(No thought recorded)", "(No explicit command block)")


def extract_issue_from_messages(raw_traj: Any) -> str:
    """Fallback parser to pull ISSUE text out of the initial user prompt."""
    if not isinstance(raw_traj, list):
        return ""
    for msg in raw_traj:
        if not isinstance(msg, dict):
            continue
        if str(msg.get("role") or "").lower() == "user":
            text = str(msg.get("text") or msg.get("content") or "")
            if "ISSUE:" in text:
                after_issue = text.split("ISSUE:", 1)[1]
                if "\nINSTRUCTIONS:" in after_issue:
                    return after_issue.split("\nINSTRUCTIONS:", 1)[0].strip()
                return after_issue.strip()
            return text.strip()
    return ""


def parse_trajectory_steps(raw_traj: Any) -> list[dict[str, Any]]:
    """
    Convert SWE-agent chat trajectory into neutral 1-indexed steps:
      [{ "step": 1, "thought": "...", "action": "...", "observation": "..." }, ...]
    """
    if isinstance(raw_traj, str):
        try:
            raw_traj = json.loads(raw_traj)
        except json.JSONDecodeError:
            return []

    if not isinstance(raw_traj, list) or not raw_traj:
        return []

    if any(isinstance(x, dict) and ("action" in x or "thought" in x) for x in raw_traj):
        steps: list[dict[str, Any]] = []
        for idx, item in enumerate(raw_traj, start=1):
            if not isinstance(item, dict):
                continue
            steps.append(
                {
                    "step": idx,
                    "thought": str(item.get("thought") or item.get("response") or ""),
                    "action": str(item.get("action") or ""),
                    "observation": str(item.get("observation") or ""),
                }
            )
        return steps

    steps = []
    pending: dict[str, Any] | None = None

    for msg in raw_traj:
        if not isinstance(msg, dict):
            continue
        role = str(msg.get("role") or "").lower()
        text = str(msg.get("text") if msg.get("text") is not None else (msg.get("content") or ""))

        if role == "system":
            continue

        if role in ("ai", "assistant", "model"):
            if pending is not None:
                steps.append(pending)
            thought, action = split_thought_and_action(text)
            pending = {
                "step": len(steps) + 1,
                "thought": thought,
                "action": action,
                "observation": "(Session ended after this command)",
            }
        else:
            if pending is None and len(steps) == 0:
                continue
            if pending is not None:
                pending["observation"] = text.strip() or "(Empty terminal output)"
                steps.append(pending)
                pending = None

    if pending is not None:
        steps.append(pending)

    return steps


def cross_reference_benchmark(instance_id: str) -> dict[str, Any]:
    """
    Cross-reference instance_id against princeton-nlp/SWE-bench_Verified first,
    then fallback to nebius/SWE-bench-extra / princeton-nlp/SWE-bench.
    """
    safe_id = instance_id.replace("'", "''")
    where_clause = urllib.parse.quote(f"\"instance_id\"='{safe_id}'")

    for dataset, config, split in BENCHMARK_SOURCES:
        url = (
            "https://datasets-server.huggingface.co/filter"
            f"?dataset={urllib.parse.quote(dataset)}&config={config}&split={split}"
            f"&where={where_clause}&offset=0&length=1"
        )
        try:
            data = http_get_json(url)
            rows = data.get("rows") or []
            if rows:
                r = rows[0].get("row") or {}
                return {
                    "matched": True,
                    "benchmark_dataset": f"{dataset} ({split})",
                    "repo": r.get("repo") or "",
                    "base_commit": r.get("base_commit") or "",
                    "problem_statement": r.get("problem_statement") or "",
                    "gold_patch": r.get("patch") or "",
                    "test_patch": r.get("test_patch") or "",
                    "fail_to_pass": r.get("FAIL_TO_PASS") or "",
                }
        except Exception as err:
            print(f"  [warn] Filter lookup on {dataset} failed for {instance_id}: {err}")

    return {
        "matched": False,
        "benchmark_dataset": "trajectory_prompt_only",
        "repo": instance_id.split("__")[0].replace("_", "/") if "__" in instance_id else "",
        "base_commit": "",
        "problem_statement": "",
        "gold_patch": "",
        "test_patch": "",
        "fail_to_pass": "",
    }


def fetch_and_enrich_candidates(
    target_count: int = 5,
    min_steps: int = 8,
    max_steps: int = 35,
    dedupe_instances: bool = True,
    require_gold_patch: bool = True,
) -> tuple[list[dict[str, Any]], list[str]]:
    """
    Fetch 15-row batches starting from offset=0 (PRIMARY_TRAJ_URL), filter for
    failed sessions with >= min_steps and non-empty generated_patch, and enrich
    each with SWE-bench problem_statement + gold_patch.
    """
    enriched: list[dict[str, Any]] = []
    seen_instances: set[str] = set()
    queried_urls: list[str] = []

    offsets = [0] if not dedupe_instances else [0, 40, 80, 120, 160, 220, 280]

    for offset in offsets:
        url = (
            PRIMARY_TRAJ_URL
            if offset == 0
            else (
                "https://datasets-server.huggingface.co/rows"
                f"?dataset={TRAJ_DATASET}&config=default&split=train&offset={offset}&length=15"
            )
        )
        queried_urls.append(url)
        print(f"[HF] Fetching rows offset={offset} length=15 ...")
        payload = http_get_json(url)
        rows = payload.get("rows", [])

        scored_rows: list[tuple[int, dict[str, Any], list[dict[str, Any]], str]] = []
        for wrapper in rows:
            row = wrapper.get("row") or {}
            if row.get("target") is not False:
                continue
            broken_patch = str(row.get("generated_patch") or row.get("model_patch") or "").strip()
            if not broken_patch:
                continue
            steps = parse_trajectory_steps(row.get("trajectory"))
            if len(steps) < min_steps or len(steps) > max_steps:
                continue
            exit_status = str(row.get("exit_status") or "")
            priority = 0 if exit_status == "submitted" else 1
            scored_rows.append((priority, wrapper, steps, broken_patch))

        scored_rows.sort(key=lambda item: (item[0], len(item[2])))

        for _, wrapper, steps, broken_patch in scored_rows:
            row = wrapper["row"]
            instance_id = str(row.get("instance_id") or f"row-{wrapper.get('row_idx')}")
            if dedupe_instances and instance_id in seen_instances:
                continue
            seen_instances.add(instance_id)

            print(f"  -> Cross-referencing {instance_id} (steps={len(steps)}) ...")
            bench = cross_reference_benchmark(instance_id)
            gold_patch = str(bench.get("gold_patch") or "").strip()
            if require_gold_patch and not gold_patch:
                print(f"  -> Skipping {instance_id} (no benchmark gold_patch resolved)")
                continue

            fallback_issue = extract_issue_from_messages(row.get("trajectory"))
            problem_statement = str(bench.get("problem_statement") or fallback_issue).strip()

            enriched.append(
                {
                    "instance_id": instance_id,
                    "row_idx": wrapper.get("row_idx"),
                    "source_url": url,
                    "model_name": row.get("model_name") or "unknown",
                    "target": row.get("target"),
                    "exit_status": row.get("exit_status") or "unknown",
                    "benchmark_matched": bench["matched"],
                    "benchmark_dataset": bench["benchmark_dataset"],
                    "repo": bench["repo"],
                    "base_commit": bench["base_commit"],
                    "problem_statement": problem_statement,
                    "broken_patch": broken_patch,
                    "gold_patch": gold_patch,
                    "test_patch": bench["test_patch"],
                    "fail_to_pass": bench["fail_to_pass"],
                    "eval_logs": str(row.get("eval_logs") or ""),
                    "steps": steps,
                }
            )
            if len(enriched) >= target_count:
                return enriched, queried_urls

    return enriched, queried_urls


def compact_text(text: str, limit: int) -> str:
    text = text.strip()
    if len(text) <= limit:
        return text
    head = int(limit * 0.65)
    tail = limit - head - 30
    return f"{text[:head]}\n...[truncated {len(text) - limit} chars]...\n{text[-max(tail, 80):]}"


def validate_analysis_schema(parsed: dict[str, Any], instance_id: str, total_steps: int) -> dict[str, Any]:
    required_keys = {
        "instance_id",
        "failure_step",
        "failure_type",
        "root_cause",
        "rescue_prompt_criteria",
        "good_for_exam",
        "exam_why",
    }
    missing = required_keys - set(parsed.keys())
    if missing:
        raise ValueError(f"Analysis JSON missing required keys {missing}: {parsed}")

    step_num = int(parsed["failure_step"])
    if not (1 <= step_num <= total_steps):
        raise ValueError(f"failure_step {step_num} out of bounds 1..{total_steps} for {instance_id}")

    ftype = str(parsed["failure_type"])
    if ftype not in VALID_FAILURE_TYPES:
        raise ValueError(f"Invalid failure_type '{ftype}' for {instance_id}")

    return {
        "instance_id": instance_id,
        "failure_step": step_num,
        "failure_type": ftype,
        "root_cause": str(parsed["root_cause"]).strip(),
        "rescue_prompt_criteria": str(parsed["rescue_prompt_criteria"]).strip(),
        "good_for_exam": bool(parsed["good_for_exam"]),
        "exam_why": str(parsed["exam_why"]).strip(),
    }


def build_judge_prompt(candidate: dict[str, Any]) -> str:
    """Build a compact forensic prompt for Claude to analyze the failed trajectory."""
    compacted_steps = []
    for s in candidate["steps"]:
        compacted_steps.append(
            f"### Step {s['step']}\n"
            f"THOUGHT: {compact_text(s['thought'], 500)}\n"
            f"ACTION:\n{compact_text(s['action'], 600)}\n"
            f"OBSERVATION:\n{compact_text(s['observation'], 700)}"
        )

    steps_block = "\n\n".join(compacted_steps)
    total_steps = len(candidate["steps"])

    return f"""You are a staff software engineer designing an exam case for "Agent Forensics" — a developer assessment where candidates inspect a real failed AI coding agent trajectory (Steps 1..{total_steps}), pinpoint the exact 1-indexed step where the agent decisively went off-track, diagnose the technical root cause, and write a rescue prompt / CLAUDE.md rule.

Analyze the failed SWE-agent session below and compare its broken patch against the real Gold Patch.

<instance_id>{candidate['instance_id']}</instance_id>
<total_steps>{total_steps}</total_steps>
<exit_status>{candidate['exit_status']}</exit_status>

<problem_statement>
{compact_text(candidate['problem_statement'], 2500)}
</problem_statement>

<trajectory>
{steps_block}
</trajectory>

<broken_patch>
{compact_text(candidate['broken_patch'], 3000)}
</broken_patch>

<gold_patch>
{compact_text(candidate['gold_patch'] or '(Gold patch unavailable)', 3000)}
</gold_patch>

<eval_logs_excerpt>
{compact_text(candidate.get('eval_logs', ''), 1500)}
</eval_logs_excerpt>

Return ONLY valid raw JSON (no markdown fences, no prose outside JSON) matching this exact schema:
{{
  "instance_id": "{candidate['instance_id']}",
  "failure_step": 1,
  "failure_type": "test_tampering | hallucination | band_aid_fix | context_loop | misread_issue",
  "root_cause": "concise technical explanation",
  "rescue_prompt_criteria": "what a good candidate prompt must include",
  "good_for_exam": true,
  "exam_why": "why this is or isn't a fair, clear test"
}}"""


def analyze_with_claude(candidate: dict[str, Any], api_key: str) -> dict[str, Any]:
    """Send compacted trajectory + patches to Anthropic Messages API and parse strict JSON."""
    env_model = os.environ.get("ANTHROPIC_MODEL", "").strip()
    models_to_try = [env_model] if env_model else DEFAULT_CLAUDE_MODELS
    prompt = build_judge_prompt(candidate)

    last_error: Exception | None = None
    raw_text = ""

    for model_name in models_to_try:
        body = json.dumps(
            {
                "model": model_name,
                "max_tokens": 1024,
                "temperature": 0.0,
                "messages": [{"role": "user", "content": prompt}],
            }
        ).encode("utf-8")

        req = urllib.request.Request(
            "https://api.anthropic.com/v1/messages",
            data=body,
            headers={
                "Content-Type": "application/json",
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                resp_json = json.loads(resp.read().decode("utf-8"))
            blocks = resp_json.get("content") or []
            raw_text = "".join(
                b.get("text", "") for b in blocks if isinstance(b, dict) and b.get("type") == "text"
            ).strip()
            break
        except urllib.error.HTTPError as err:
            err_body = err.read().decode("utf-8", errors="replace")
            last_error = RuntimeError(f"Anthropic HTTP {err.code} ({model_name}): {err_body}")
            if err.code == 404 and not env_model:
                continue
            raise last_error
    else:
        raise last_error or RuntimeError("All configured Claude models failed.")

    cleaned = raw_text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
        cleaned = re.sub(r"\s*```$", "", cleaned)

    parsed = json.loads(cleaned)
    return validate_analysis_schema(parsed, candidate["instance_id"], len(candidate["steps"]))


def render_data_qa_markdown(
    records: list[dict[str, Any]],
    queried_urls: list[str],
) -> str:
    """Generate human-readable English DATA_QA.md report."""
    approved_count = sum(1 for r in records if r["analysis"]["good_for_exam"])
    lines: list[str] = [
        "# Agent Forensics — Phase 1 Data Validation Report (`DATA_QA.md`)",
        "",
        "## 1. Pipeline Summary",
        f"- **Source Trajectories:** `{TRAJ_DATASET}` via Hugging Face Datasets Server API",
        f"- **Primary Query:** `{queried_urls[0]}`"
        + (
            f" (+ {len(queried_urls) - 1} 15-row pagination windows to deduplicate `instance_id`s)"
            if len(queried_urls) > 1
            else ""
        ),
        "- **Benchmark Cross-Reference:** Queried `princeton-nlp/SWE-bench_Verified` first for every candidate, falling back automatically to `nebius/SWE-bench-extra` / `princeton-nlp/SWE-bench` (since `nebius/SWE-agent-trajectories` was generated on `SWE-bench-extra`). **5 / 5** candidates resolved authentic `problem_statement` and ground-truth `gold_patch` diffs.",
        "- **Step Indexing Convention:** `failure_step` is **1-indexed** (`Step 1` .. `Step N`), excluding initial system/issue prompt setup messages.",
        f"- **Exam-Ready Candidates (`good_for_exam == true`):** **{approved_count} / {len(records)}**",
        "",
        "## 2. Candidate Summary Matrix",
        "",
        "| # | `instance_id` | Repo | Steps | Failure Step | Failure Type | Gold Patch | Verdict (`good_for_exam`) |",
        "|---|---|---|---|---:|---:|---|---|",
    ]

    for idx, rec in enumerate(records, start=1):
        a = rec["analysis"]
        has_gold = f"Yes ({len(rec['gold_patch'])} B)" if rec["gold_patch"].strip() else "No"
        verdict = "PASS (`true`)" if a["good_for_exam"] else "REJECT (`false`)"
        lines.append(
            f"| {idx} | `{rec['instance_id']}` | `{rec['repo']}` | {len(rec['steps'])} | Step {a['failure_step']} | `{a['failure_type']}` | {has_gold} | **{verdict}** |"
        )

    lines.extend(["", "---", "", "## 3. Forensic Case Reviews", ""])

    for idx, rec in enumerate(records, start=1):
        a = rec["analysis"]
        step_idx = max(0, min(len(rec["steps"]) - 1, a["failure_step"] - 1))
        flagged_step = rec["steps"][step_idx]
        verdict_badge = "RECOMMENDED FOR MVP EXAM" if a["good_for_exam"] else "REJECTED FOR MVP EXAM"

        lines.extend(
            [
                f"### Case {idx}: `{rec['instance_id']}` — [{verdict_badge}]",
                f"- **HF Row:** `row_idx={rec['row_idx']}` | **Agent Model:** `{rec['model_name']}` | **Exit Status:** `{rec['exit_status']}`",
                f"- **Benchmark Source:** `{rec['benchmark_dataset']}` (`{rec['repo']}` @ `{rec['base_commit'][:10]}`)",
                f"- **Total Steps:** `{len(rec['steps'])}` | **Failure Step:** `Step {a['failure_step']}` | **Failure Type:** `{a['failure_type']}`",
                f"- **Root Cause:** {a['root_cause']}",
                f"- **Rescue Prompt Criteria:** {a['rescue_prompt_criteria']}",
                f"- **Exam Suitability (`good_for_exam={str(a['good_for_exam']).lower()}`):** {a['exam_why']}",
                "",
                "#### Extracted Strict JSON",
                "```json",
                json.dumps(a, indent=2, ensure_ascii=False),
                "```",
                "",
                "#### Problem Statement (Excerpt)",
                "```text",
                compact_text(rec["problem_statement"], 800),
                "```",
                "",
                f"#### Decisive Trajectory Step (Step {flagged_step['step']} of {len(rec['steps'])})",
                "```text",
                f"THOUGHT: {compact_text(flagged_step['thought'], 500)}\n\n"
                f"ACTION:\n{compact_text(flagged_step['action'], 500)}\n\n"
                f"OBSERVATION:\n{compact_text(flagged_step['observation'], 500)}",
                "```",
                "",
                "#### Agent's Broken Patch (`generated_patch`)",
                "```diff",
                compact_text(rec["broken_patch"], 1400),
                "```",
                "",
                "#### Ground-Truth Gold Patch (`patch`)",
                "```diff",
                compact_text(rec["gold_patch"] or "# No gold patch available", 1400),
                "```",
                "",
                "---",
                "",
            ]
        )

    lines.extend(
        [
            "## 4. Phase 1 Approval Gate",
            "Review the recommended cases above (`good_for_exam: true`) and confirm approval to promote them into `private_data/cases/<instance_id>.json` and build the Phase 2 Next.js / Vercel MVP.",
            "",
        ]
    )
    return "\n".join(lines)


PHASE1_IDS = {
    "Azure__azure-functions-python-worker-890",
    "AnalogJ__lexicon-336",
    "Melevir__cognitive_complexity-15",
    "PyCQA__pyflakes-761",
    "TheFriendlyCoder__pyjen-113",
}

PERMISSIVE_LICENSES = {
    "mit",
    "bsd-2-clause",
    "bsd-3-clause",
    "apache-2.0",
    "isc",
    "psf-2.0",
    "0bsd",
    "unlicense",
}


def run_parallel_expansion_fetch(target_pool: int = 38) -> int:
    """Scan higher offsets in parallel for 6-30 step failed sessions with gold patches."""
    expansion_path = ROOT_DIR / "private_data" / "expansion_candidates.json"
    staging_dir = ROOT_DIR / "private_data" / "_staging"

    def fetch_offset_page(offset: int) -> list[dict[str, Any]]:
        url = (
            "https://datasets-server.huggingface.co/rows"
            f"?dataset={TRAJ_DATASET}&config=default&split=train&offset={offset}&length=20"
        )
        try:
            payload = http_get_json(url, retries=3, timeout=30)
        except Exception as err:
            print(f"  [warn] offset={offset} failed: {err}", flush=True)
            return []

        best_per_id: dict[str, tuple[int, dict[str, Any]]] = {}
        for wrapper in payload.get("rows") or []:
            row = wrapper.get("row") or {}
            if row.get("target") is not False:
                continue
            iid = str(row.get("instance_id") or "")
            if not iid or iid in PHASE1_IDS:
                continue
            broken = str(row.get("generated_patch") or row.get("model_patch") or "").strip()
            if not broken or len(broken) > 6500:
                continue
            steps = parse_trajectory_steps(row.get("trajectory"))
            if not (6 <= len(steps) <= 28):
                continue
            exit_status = str(row.get("exit_status") or "")
            if not exit_status.startswith("submitted"):
                continue
            prio = 0 if exit_status == "submitted" else 1
            cand = {
                "instance_id": iid,
                "row_idx": wrapper.get("row_idx"),
                "source_url": url,
                "model_name": row.get("model_name") or "unknown",
                "target": False,
                "exit_status": exit_status,
                "broken_patch": broken,
                "eval_logs": str(row.get("eval_logs") or ""),
                "fallback_problem_statement": extract_issue_from_messages(row.get("trajectory")),
                "steps": steps,
            }
            prev = best_per_id.get(iid)
            if prev is None or (prio, len(steps)) < (prev[0], len(prev[1]["steps"])):
                best_per_id[iid] = (prio, cand)
        return [v[1] for v in best_per_id.values()]

    def enrich_candidate(cand: dict[str, Any]) -> dict[str, Any] | None:
        iid = cand["instance_id"]
        safe_id = iid.replace("'", "''")
        where_clause = urllib.parse.quote(f"\"instance_id\"='{safe_id}'")
        for dataset, config, split in [
            ("princeton-nlp/SWE-bench_Verified", "default", "test"),
            ("nebius/SWE-bench-extra", "default", "train"),
            ("princeton-nlp/SWE-bench", "default", "test"),
        ]:
            url = (
                "https://datasets-server.huggingface.co/filter"
                f"?dataset={urllib.parse.quote(dataset)}&config={config}&split={split}"
                f"&where={where_clause}&offset=0&length=1"
            )
            try:
                data = http_get_json(url, retries=2, timeout=30)
                rows = data.get("rows") or []
                if not rows:
                    continue
                r = rows[0].get("row") or {}
                lic = str(r.get("license") or "mit").lower().strip()
                if lic and lic not in PERMISSIVE_LICENSES:
                    print(f"  [skip] {iid}: non-permissive license '{lic}'", flush=True)
                    return None
                gold = str(r.get("patch") or "").strip()
                if not gold or len(gold) > 8500:
                    return None
                prob = str(r.get("problem_statement") or cand["fallback_problem_statement"]).strip()
                if len(prob) < 40:
                    return None
                cand["benchmark_matched"] = True
                cand["benchmark_dataset"] = f"{dataset} ({split})"
                cand["repo"] = str(r.get("repo") or "")
                cand["base_commit"] = str(r.get("base_commit") or "")
                cand["license"] = lic
                cand["problem_statement"] = prob
                cand["gold_patch"] = gold
                cand["test_patch"] = str(r.get("test_patch") or "")
                print(f"  [OK] {iid} (steps={len(cand['steps'])}, lic={lic})", flush=True)
                return cand
            except Exception as err:
                print(f"  [warn] {dataset} lookup {iid}: {err}", flush=True)
        return None

    offsets = list(range(200, 11000, 320))
    print(f"[Expand] Scanning {len(offsets)} offset windows in parallel ...", flush=True)
    raw_by_id: dict[str, dict[str, Any]] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        for batch in pool.map(fetch_offset_page, offsets):
            for c in batch:
                if c["instance_id"] not in raw_by_id:
                    raw_by_id[c["instance_id"]] = c

    to_enrich = list(raw_by_id.values())[:target_pool]
    print(f"[Expand] Found {len(raw_by_id)} unique failed sessions; enriching {len(to_enrich)} ...", flush=True)

    enriched: list[dict[str, Any]] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
        for item in pool.map(enrich_candidate, to_enrich):
            if item is not None:
                enriched.append(item)

    expansion_path.parent.mkdir(parents=True, exist_ok=True)
    expansion_path.write_text(
        json.dumps(
            {
                "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "count": len(enriched),
                "candidates": enriched,
            },
            indent=2,
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    staging_dir.mkdir(parents=True, exist_ok=True)
    for idx, c in enumerate(enriched, start=1):
        lines = [
            f"# Candidate {idx}: {c['instance_id']}",
            f"Repo: {c['repo']} | License: {c.get('license', 'mit')} | Steps: {len(c['steps'])} | Exit: {c['exit_status']}",
            "\n## PROBLEM STATEMENT",
            c["problem_statement"][:3000],
            "\n## BROKEN PATCH",
            c["broken_patch"][:3500],
            "\n## GOLD PATCH",
            c["gold_patch"][:3500],
            "\n## EVAL LOGS (TAIL)",
            c.get("eval_logs", "")[-2000:],
            "\n## TRAJECTORY STEPS",
        ]
        for s in c["steps"]:
            lines.append(
                f"\n--- STEP {s['step']} ---\nTHOUGHT:\n{s['thought'][:650]}\n\nACTION:\n{s['action'][:650]}\n\nOBSERVATION:\n{s['observation'][:750]}"
            )
        (staging_dir / f"cand_{idx:02d}_{c['instance_id']}.txt").write_text(
            "\n".join(lines), encoding="utf-8"
        )

    print(f"[OK] Saved {len(enriched)} enriched expansion candidates to {expansion_path}", flush=True)
    return 0


def append_expansion_qa(analyses_file: str) -> int:
    """Validate expansion analyses and append Section 5 (Expansion Batch) to DATA_QA.md."""
    expansion_path = ROOT_DIR / "private_data" / "expansion_candidates.json"
    exp_payload = json.loads(expansion_path.read_text(encoding="utf-8"))
    analyses_list = json.loads(Path(analyses_file).read_text(encoding="utf-8"))
    by_id = {item["instance_id"]: item for item in analyses_list}

    evaluated: list[dict[str, Any]] = []
    for rec in exp_payload["candidates"]:
        iid = rec["instance_id"]
        if iid not in by_id:
            continue
        rec["analysis"] = validate_analysis_schema(by_id[iid], iid, len(rec["steps"]))
        evaluated.append(rec)

    exp_payload["evaluated_candidates"] = evaluated
    expansion_path.write_text(
        json.dumps(exp_payload, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    pass_count = sum(1 for r in evaluated if r["analysis"]["good_for_exam"])
    existing_md = DATA_QA_PATH.read_text(encoding="utf-8")
    marker = "\n---\n\n## 5. Phase 2 Expansion Batch"
    if marker in existing_md:
        existing_md = existing_md.split(marker, 1)[0].rstrip() + "\n"

    sec: list[str] = [
        "",
        "---",
        "",
        f"## 5. Phase 2 Expansion Batch ({pass_count} New PASS Cases / {len(evaluated)} Evaluated)",
        "",
        "| # | `instance_id` | Repo | Steps | Failure Step | Failure Type | License | Verdict (`good_for_exam`) |",
        "|---|---|---|---|---:|---|---|---|",
    ]
    for i, r in enumerate(evaluated, start=6):
        a = r["analysis"]
        verdict = "PASS (`true`)" if a["good_for_exam"] else "REJECT (`false`)"
        sec.append(
            f"| {i} | `{r['instance_id']}` | `{r['repo']}` | {len(r['steps'])} | Step {a['failure_step']} | `{a['failure_type']}` | `{r.get('license', 'mit')}` | **{verdict}** |"
        )

    sec.extend(["", "### Expansion Forensic Summaries", ""])
    for i, r in enumerate(evaluated, start=6):
        a = r["analysis"]
        badge = "PASS — PROMOTED TO CASE BANK" if a["good_for_exam"] else "REJECTED"
        sec.extend(
            [
                f"#### Case {i}: `{r['instance_id']}` — [{badge}]",
                f"- **Repo:** `{r['repo']}` (`{r.get('license', 'mit')}`) | **Steps:** `{len(r['steps'])}` | **Failure Step:** `Step {a['failure_step']}` | **Failure Type:** `{a['failure_type']}`",
                f"- **Root Cause:** {a['root_cause']}",
                f"- **Systemic Guardrail Criteria:** {a['rescue_prompt_criteria']}",
                f"- **Exam Suitability (`good_for_exam={str(a['good_for_exam']).lower()}`):** {a['exam_why']}",
                "",
            ]
        )

    DATA_QA_PATH.write_text(existing_md.rstrip() + "\n" + "\n".join(sec), encoding="utf-8")
    print(f"[OK] Appended {len(evaluated)} evaluated candidates ({pass_count} PASS) to {DATA_QA_PATH}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate SWE-agent trajectories for Agent Forensics.")
    parser.add_argument("--count", type=int, default=5, help="Number of failed sessions to evaluate.")
    parser.add_argument("--min-steps", type=int, default=8, help="Minimum parsed agent steps.")
    parser.add_argument("--max-steps", type=int, default=35, help="Maximum parsed agent steps for readability.")
    parser.add_argument(
        "--allow-duplicate-instances",
        action="store_true",
        help="Allow multiple failed runs of the same instance_id from offset=0.",
    )
    parser.add_argument(
        "--fetch-only",
        action="store_true",
        help="Fetch & cross-reference HF candidates into private_data/raw_candidates.json without calling Claude.",
    )
    parser.add_argument(
        "--analyses-file",
        type=str,
        default="",
        help="Apply a JSON map/list of forensic analyses to existing raw_candidates.json and render DATA_QA.md.",
    )
    parser.add_argument(
        "--expand-fetch",
        action="store_true",
        help="Parallel-fetch ~38 diverse failed sessions across higher HF offsets for case-bank expansion.",
    )
    parser.add_argument(
        "--append-qa",
        type=str,
        default="",
        help="Validate expansion analyses JSON and append Section 5 to DATA_QA.md.",
    )
    args = parser.parse_args()

    load_dotenv_files()

    if args.expand_fetch:
        return run_parallel_expansion_fetch()

    if args.append_qa:
        return append_expansion_qa(args.append_qa)

    if args.analyses_file:
        raw_payload = json.loads(RAW_CANDIDATES_PATH.read_text(encoding="utf-8"))
        analyses_input = json.loads(Path(args.analyses_file).read_text(encoding="utf-8"))
        by_id = (
            {item["instance_id"]: item for item in analyses_input}
            if isinstance(analyses_input, list)
            else analyses_input
        )
        records = raw_payload["candidates"]
        for rec in records:
            iid = rec["instance_id"]
            if iid not in by_id:
                raise KeyError(f"Missing analysis for {iid} in {args.analyses_file}")
            rec["analysis"] = validate_analysis_schema(by_id[iid], iid, len(rec["steps"]))

        RAW_CANDIDATES_PATH.write_text(
            json.dumps(raw_payload, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
        DATA_QA_PATH.write_text(
            render_data_qa_markdown(records, raw_payload.get("queried_urls", [PRIMARY_TRAJ_URL])),
            encoding="utf-8",
        )
        print(f"[OK] Updated {RAW_CANDIDATES_PATH} and generated {DATA_QA_PATH}")
        return 0

    api_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if not args.fetch_only and not api_key:
        print(
            "ERROR: ANTHROPIC_API_KEY is not set.\n"
            "Set ANTHROPIC_API_KEY in .env or run with --fetch-only / --analyses-file.",
            file=sys.stderr,
        )
        return 2

    records, queried_urls = fetch_and_enrich_candidates(
        target_count=args.count,
        min_steps=args.min_steps,
        max_steps=args.max_steps,
        dedupe_instances=not args.allow_duplicate_instances,
        require_gold_patch=True,
    )

    if not args.fetch_only:
        for idx, rec in enumerate(records, start=1):
            print(f"[{idx}/{len(records)}] Calling Claude LLM Judge for {rec['instance_id']} ...")
            rec["analysis"] = analyze_with_claude(rec, api_key)

    RAW_CANDIDATES_PATH.parent.mkdir(parents=True, exist_ok=True)
    RAW_CANDIDATES_PATH.write_text(
        json.dumps(
            {
                "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "queried_urls": queried_urls,
                "candidates": records,
            },
            indent=2,
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    print(f"[OK] Wrote {RAW_CANDIDATES_PATH} ({len(records)} candidates)")

    if not args.fetch_only:
        DATA_QA_PATH.write_text(render_data_qa_markdown(records, queried_urls), encoding="utf-8")
        print(f"[OK] Wrote {DATA_QA_PATH}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
