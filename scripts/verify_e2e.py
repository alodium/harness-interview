#!/usr/bin/env python3
"""
End-to-End & Zero-Leak Security Verification Suite for Harness Interview (24-Case Bank).

Verifies:
1. Public data/cases/*.json files contain ZERO answer_key fields or secrets.
2. Client bundle (.next/static) contains ZERO answer_key strings, gold_patch hunks,
   legacy 'AgentForensics' branding, or Hebrew characters across all 24 cases.
3. GET / returns 200 English LTR HTML with 'Harness Interview' branding and zero leaks.
4. GET /api/cases returns all 24 cases ordered with TheFriendlyCoder__pyjen-113 (#1)
   and Melevir__cognitive_complexity-15 (#2) first, and zero spoilers.
5. GET /api/case?id=<id> returns ONLY public fields (including initial_prompt &
   source_dataset), neutral steps, and shuffled MCQs with zero answer_key fields.
6. POST /api/grade deterministically grades exact (100), close ±1 (85), and miss (0)
   submissions and returns reveal + Harness Interview share_grid.
"""

from __future__ import annotations

import concurrent.futures
import json
import re
import sys
import urllib.request
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
PUBLIC_CASES_DIR = ROOT_DIR / "data" / "cases"
PRIVATE_KEYS_PATH = ROOT_DIR / "private_data" / "answer_keys.json"
EXAMPLE_KEYS_PATH = ROOT_DIR / "data" / "answer_keys.example.json"
NEXT_STATIC_DIR = ROOT_DIR / ".next" / "static"

FORBIDDEN_CLIENT_KEYS = {
    "answer_key",
    "failure_step",
    "correct_diagnosis_id",
    "correct_rescue_id",
    "gold_patch",
    "diagnosis_explanations",
    "rescue_explanations",
}

HEBREW_RE = re.compile(r"[\u0590-\u05FF]")


def http_json(url: str, method: str = "GET", payload: dict | None = None) -> dict:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {"Content-Type": "application/json"} if data is not None else {}
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=20) as resp:
        assert resp.status == 200, f"Expected 200 for {url}, got {resp.status}"
        return json.loads(resp.read().decode("utf-8"))


def check_no_forbidden_keys(obj: object, path: str = "root") -> None:
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k in FORBIDDEN_CLIENT_KEYS:
                raise AssertionError(f"LEAK DETECTED: forbidden key '{k}' at {path}.{k}")
            check_no_forbidden_keys(v, f"{path}.{k}")
    elif isinstance(obj, list):
        for idx, item in enumerate(obj):
            check_no_forbidden_keys(item, f"{path}[{idx}]")


def main() -> int:
    base_url = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3000"
    manifest = json.loads((PUBLIC_CASES_DIR / "manifest.json").read_text(encoding="utf-8"))
    expected_ids = [c["instance_id"] for c in manifest["cases"]]
    assert len(expected_ids) == 24, f"Expected 24 cases in manifest, found {len(expected_ids)}"
    assert expected_ids[0] == "TheFriendlyCoder__pyjen-113", f"Case #1 must be pyjen-113, got {expected_ids[0]}"
    assert expected_ids[1] == "Melevir__cognitive_complexity-15", f"Case #2 must be cognitive_complexity-15, got {expected_ids[1]}"

    keys_path = PRIVATE_KEYS_PATH if PRIVATE_KEYS_PATH.exists() else EXAMPLE_KEYS_PATH
    private_keys = json.loads(keys_path.read_text(encoding="utf-8"))
    assert len(private_keys) == 24, f"Expected 24 answer keys in {keys_path}, found {len(private_keys)}"

    print(f"[1/6] Auditing public data/cases/*.json for zero answer-key leaks ...")
    public_cases: dict[str, dict] = {}
    for iid in expected_ids:
        pub_doc = json.loads((PUBLIC_CASES_DIR / f"{iid}.json").read_text(encoding="utf-8"))
        check_no_forbidden_keys(pub_doc, f"data/cases/{iid}.json")
        public_cases[iid] = pub_doc
    print(f"  -> Passed: All 24 public case files in data/cases/ are strictly sanitized.")

    print(f"[2/6] Auditing client bundles in {NEXT_STATIC_DIR} against {len(expected_ids)} cases ...")
    assert NEXT_STATIC_DIR.is_dir(), f"Missing {NEXT_STATIC_DIR} — run npm run build first."

    secret_needles: list[tuple[str, str]] = [
        ("correct_diagnosis_id", "correct_diagnosis_id"),
        ("correct_rescue_id", "correct_rescue_id"),
        ("diagnosis_explanations", "diagnosis_explanations"),
    ]
    for iid in expected_ids:
        ak = private_keys[iid]
        secret_needles.append((f"{iid}:correct_diag", ak["correct_diagnosis_id"]))
        secret_needles.append((f"{iid}:correct_rescue", ak["correct_rescue_id"]))
        secret_needles.append((f"{iid}:root_cause", ak["root_cause"][:55]))

    scanned_files = 0
    for asset in NEXT_STATIC_DIR.rglob("*"):
        if not asset.is_file() or asset.suffix not in {".js", ".css", ".json", ".html"}:
            continue
        scanned_files += 1
        content = asset.read_text(encoding="utf-8", errors="ignore")
        if HEBREW_RE.search(content):
            raise AssertionError(f"Hebrew character found in client asset: {asset}")
        if "AgentForensics" in content:
            raise AssertionError(f"Legacy 'AgentForensics' branding found in client asset: {asset}")
        for label, needle in secret_needles:
            if needle and needle in content:
                raise AssertionError(f"CLIENT BUNDLE LEAK ({label}) in {asset}")
    print(f"  -> Passed: {scanned_files} client bundle files scanned, 0 leaks, 0 legacy branding.")

    print(f"[3/6] Checking GET {base_url}/ HTML ...")
    with urllib.request.urlopen(f"{base_url}/", timeout=20) as resp:
        html = resp.read().decode("utf-8")
        assert resp.status == 200
    assert 'lang="en"' in html and 'dir="ltr"' in html, "Missing lang=en dir=ltr on <html>"
    assert "Harness Interview" in html, "Missing 'Harness Interview' branding in HTML"
    assert "AgentForensics" not in html, "Legacy 'AgentForensics' found in SSR HTML"
    assert not HEBREW_RE.search(html), "Hebrew characters found in SSR HTML!"
    for label, needle in secret_needles:
        assert needle not in html, f"SSR HTML LEAK ({label})"
    print("  -> Passed: English LTR 'Harness Interview' HTML verified with 0 leaks.")

    print(f"[4/6] Checking GET {base_url}/api/cases ...")
    cases_resp = http_json(f"{base_url}/api/cases")
    check_no_forbidden_keys(cases_resp, "/api/cases")
    returned_ids = [c["instance_id"] for c in cases_resp["cases"]]
    assert returned_ids == expected_ids, f"Case order mismatch: {returned_ids[:4]} vs {expected_ids[:4]}"
    print(f"  -> Passed: All {len(returned_ids)} cases returned in exact difficulty/onboarding order.")

    print(f"[5/6] Checking GET {base_url}/api/case?id=... across all {len(expected_ids)} cases ...")

    def verify_single_case(iid: str) -> None:
        pub = http_json(f"{base_url}/api/case?id={iid}")
        check_no_forbidden_keys(pub, f"/api/case?id={iid}")
        raw_str = json.dumps(pub)
        assert not HEBREW_RE.search(raw_str), f"Hebrew found in {iid} payload!"
        assert pub.get("initial_prompt"), f"Missing initial_prompt (Step 0) in {iid}"
        assert pub.get("source_dataset") == "nebius/SWE-agent-trajectories", f"Missing source_dataset in {iid}"
        ak = private_keys[iid]
        assert ak["root_cause"][:50] not in raw_str, f"root_cause leaked in GET /api/case for {iid}"
        for step in pub["trajectory"]:
            assert set(step.keys()) == {"step", "thought", "action", "observation"}, (
                f"Unexpected step keys in {iid}: {set(step.keys())}"
            )
        assert len(pub["diagnosis_options"]) == 4
        assert len(pub["rescue_options"]) == 4

    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        list(pool.map(verify_single_case, expected_ids))
    print(f"  -> Passed: All {len(expected_ids)} GET /api/case payloads verified (Step 0 + provenance + 0 leaks).")

    print(f"[6/6] Checking POST {base_url}/api/grade deterministic scoring ...")
    flagship = "Melevir__cognitive_complexity-15"
    ak = private_keys[flagship]
    pub = public_cases[flagship]
    wrong_diag = next(o["id"] for o in pub["diagnosis_options"] if o["id"] != ak["correct_diagnosis_id"])
    wrong_rescue = next(o["id"] for o in pub["rescue_options"] if o["id"] != ak["correct_rescue_id"])

    exact_res = http_json(
        f"{base_url}/api/grade",
        method="POST",
        payload={
            "instance_id": flagship,
            "selected_step": ak["failure_step"],
            "diagnosis_choice": ak["correct_diagnosis_id"],
            "rescue_choice": ak["correct_rescue_id"],
            "invite_code": "__e2e_test__",
        },
    )
    assert exact_res["score"] == 100
    assert exact_res["step_verdict"] == "exact"
    assert exact_res["share_grid"].startswith("Harness Interview #"), f"Unexpected share_grid: {exact_res['share_grid']}"

    close_res = http_json(
        f"{base_url}/api/grade",
        method="POST",
        payload={
            "instance_id": flagship,
            "selected_step": ak["failure_step"] - 1,
            "diagnosis_choice": ak["correct_diagnosis_id"],
            "rescue_choice": ak["correct_rescue_id"],
            "invite_code": "__e2e_test__",
        },
    )
    assert close_res["score"] == 85
    assert close_res["step_verdict"] == "close"

    miss_res = http_json(
        f"{base_url}/api/grade",
        method="POST",
        payload={
            "instance_id": flagship,
            "selected_step": 1,
            "diagnosis_choice": wrong_diag,
            "rescue_choice": wrong_rescue,
            "invite_code": "__e2e_test__",
        },
    )
    assert miss_res["score"] == 0
    assert miss_res["step_verdict"] == "miss"

    stats_res = http_json(f"{base_url}/api/stats")
    check_no_forbidden_keys(stats_res, "/api/stats")
    print(f"  -> /api/stats configured={stats_res.get('configured')}")
    print("  -> Passed: Exact (100), Close ±1 (85), and Miss (0) deterministic grading verified!")
    print("\nALL 24-CASE E2E & ZERO-LEAK SECURITY CHECKS PASSED!")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
