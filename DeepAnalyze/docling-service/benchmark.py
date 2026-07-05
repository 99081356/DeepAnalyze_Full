"""
GLM-OCR vs Standard pipeline benchmark.

Tests multiple documents and measures:
- Processing time
- Output length
- Heading count
- Special artifact count
- Line uniqueness (deduplication quality)

Usage:
    python3 benchmark.py [--docs DOC1 DOC2 ...] [--mode std|glm|both]
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import parser as docling_parser
from docling.datamodel.settings import settings

# Ensure optimal batch size
settings.perf.page_batch_size = 8


@dataclass
class BenchResult:
    file: str
    mode: str  # "std" or "glm"
    elapsed_s: float = 0.0
    total_chars: int = 0
    total_lines: int = 0
    unique_lines: int = 0
    heading_count: int = 0
    image_refs: int = 0
    artifact_count: int = 0
    table_count: int = 0
    page_count: int = 0
    error: str = ""


def analyze_output(content: str) -> dict:
    lines = content.split("\n")
    return {
        "total_chars": len(content),
        "total_lines": len(lines),
        "unique_lines": len(set(lines)),
        "heading_count": len([l for l in lines if l.startswith("#")]),
        "image_refs": content.count("<!-- image -->"),
        "artifact_count": len(re.findall(r"&lt;\|\w+", content)),
        "line_uniqueness": len(set(lines)) / max(len(lines), 1) * 100,
    }


def run_std(file_path: str) -> BenchResult:
    result = BenchResult(file=file_path, mode="std")
    docling_parser._converter_cache.clear()

    options = {
        "model_config": {
            "use_vlm": False,
            "artifacts_path": "data/models/docling",
        }
    }

    start = time.time()
    try:
        res = docling_parser.parse_document_sync(file_path, options)
        result.elapsed_s = time.time() - start
        content = res["content"]
        stats = analyze_output(content)
        result.total_chars = stats["total_chars"]
        result.total_lines = stats["total_lines"]
        result.unique_lines = stats["unique_lines"]
        result.heading_count = stats["heading_count"]
        result.image_refs = stats["image_refs"]
        result.artifact_count = stats["artifact_count"]
        result.table_count = len(res.get("tables", []))
        result.page_count = res.get("metadata", {}).get("page_count", 0)
    except Exception as e:
        result.elapsed_s = time.time() - start
        result.error = str(e)

    return result


def run_glm(file_path: str) -> BenchResult:
    result = BenchResult(file=file_path, mode="glm")
    docling_parser._converter_cache.clear()

    options = {
        "model_config": {
            "use_vlm": True,
            "vlm_model": "zai-org/GLM-OCR",
            "vlm_mode": "inline",
            "artifacts_path": "data/models/docling",
        }
    }

    start = time.time()
    try:
        res = docling_parser.parse_document_sync(file_path, options)
        result.elapsed_s = time.time() - start
        content = res["content"]
        stats = analyze_output(content)
        result.total_chars = stats["total_chars"]
        result.total_lines = stats["total_lines"]
        result.unique_lines = stats["unique_lines"]
        result.heading_count = stats["heading_count"]
        result.image_refs = stats["image_refs"]
        result.artifact_count = stats["artifact_count"]
        result.table_count = len(res.get("tables", []))
        result.page_count = res.get("metadata", {}).get("page_count", 0)
    except Exception as e:
        result.elapsed_s = time.time() - start
        result.error = str(e)

    return result


DEFAULT_DOCS = [
    "/mnt/d/testdata/pdf/kb/BDCC-08-00115.pdf",       # 15p, 3.9MB - English academic paper
    "/mnt/d/testdata/pdf/kb/antigravity-rag-2026.pdf",  # small, newer paper
    "/mnt/d/testdata/pdf/kb/2025.findings-acl.690.pdf",  # small ACL paper
    "/mnt/d/testdata/pdf/记忆论文/sukhbaatar21a.pdf",   # different formatting
]


def main():
    ap = argparse.ArgumentParser(description="GLM-OCR benchmark")
    ap.add_argument("--docs", nargs="+", default=DEFAULT_DOCS)
    ap.add_argument("--mode", choices=["std", "glm", "both"], default="both")
    args = ap.parse_args()

    all_results: list[BenchResult] = []

    for doc in args.docs:
        p = Path(doc)
        if not p.exists():
            print(f"SKIP: {doc} not found")
            continue

        print(f"\n{'='*60}")
        print(f"File: {p.name} ({p.stat().st_size/1024:.0f}KB)")
        print(f"{'='*60}")

        if args.mode in ("std", "both"):
            print("  [Standard] ", end="", flush=True)
            r = run_std(doc)
            if r.error:
                print(f"ERROR: {r.error[:100]}")
            else:
                print(f"{r.elapsed_s:.1f}s | {r.total_chars} chars | {r.heading_count} headings | {r.page_count} pages")
            all_results.append(r)

        if args.mode in ("glm", "both"):
            print("  [GLM-OCR]  ", end="", flush=True)
            r = run_glm(doc)
            if r.error:
                print(f"ERROR: {r.error[:100]}")
            else:
                print(f"{r.elapsed_s:.1f}s | {r.total_chars} chars | {r.heading_count} headings | {r.page_count} pages")
            all_results.append(r)

    # Summary table
    print(f"\n{'='*80}")
    print("SUMMARY")
    print(f"{'='*80}")
    print(f"{'File':<30} {'Mode':<8} {'Time':>6} {'Chars':>7} {'Heads':>6} {'Lines':>6} {'Uniq%':>6} {'Pages':>6}")
    print(f"{'-'*30} {'-'*8} {'-'*6} {'-'*7} {'-'*6} {'-'*6} {'-'*6} {'-'*6}")
    for r in all_results:
        if r.error:
            print(f"{Path(r.file).name:<30} {r.mode:<8} {'ERROR':>6}")
            continue
        uniq_pct = r.unique_lines / max(r.total_lines, 1) * 100
        print(f"{Path(r.file).name:<30} {r.mode:<8} {r.elapsed_s:>5.1f}s {r.total_chars:>7} {r.heading_count:>6} {r.total_lines:>6} {uniq_pct:>5.1f}% {r.page_count:>6}")


if __name__ == "__main__":
    main()
