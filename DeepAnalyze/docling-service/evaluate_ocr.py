"""
OCR accuracy evaluator using qwen3.6-plus via DashScope.

Compares GLM-OCR vs Standard pipeline output against the original PDF
using a VLM judge.

Usage:
    export DASHSCOPE_API_KEY="sk-xxx"
    python3 evaluate_ocr.py --pdf <file> --std <std_md> --glm <glm_md>
    python3 evaluate_ocr.py --auto   # run full pipeline + evaluate
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

import httpx

DASHSCOPE_BASE = "https://coding.dashscope.aliyuncs.com/v1"
MODEL = "qwen3.6-plus"

EVAL_PROMPT = """你是一个专业的 OCR 质量评估专家。请评估两个 OCR 系统对同一份文档的识别结果。

评估维度（每项 0-10 分）：

1. **文字准确率**: 文字识别是否正确，有无错字、漏字、多余文字
2. **结构保持**: 是否保留了原文档的章节结构（标题层级、段落分隔）
3. **格式完整**: 表格、公式、列表等格式元素是否被正确识别
4. **内容完整度**: 是否遗漏了重要内容（章节、段落、数据）
5. **可读性**: 输出作为 Markdown 是否易读、格式清晰

请按以下 JSON 格式输出评估结果，不要输出其他内容：
```json
{
  "standard": {
    "text_accuracy": <0-10>,
    "structure": <0-10>,
    "format": <0-10>,
    "completeness": <0-10>,
    "readability": <0-10>,
    "total": <0-50>,
    "strengths": "<优点>",
    "weaknesses": "<缺点>"
  },
  "glm_ocr": {
    "text_accuracy": <0-10>,
    "structure": <0-10>,
    "format": <0-10>,
    "completeness": <0-10>,
    "readability": <0-10>,
    "total": <0-50>,
    "strengths": "<优点>",
    "weaknesses": "<缺点>"
  },
  "winner": "<standard|glm_ocr|tie>",
  "summary": "<一段话总结对比结果>"
}
```"""


def call_qwen(api_key: str, messages: list[dict], temperature: float = 0.3) -> str:
    """Call qwen3.6-plus via DashScope OpenAI-compatible API."""
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": MODEL,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": 4096,
    }

    with httpx.Client(timeout=120) as client:
        resp = client.post(
            f"{DASHSCOPE_BASE}/chat/completions",
            headers=headers,
            json=payload,
        )
        resp.raise_for_status()
        data = resp.json()
        return data["choices"][0]["message"]["content"]


def evaluate_pair(
    api_key: str,
    std_content: str,
    glm_content: str,
    doc_name: str = "unknown",
) -> dict:
    """Evaluate a pair of OCR outputs using qwen3.6-plus."""

    # Truncate long outputs to fit within context
    max_chars = 15000
    std_trunc = std_content[:max_chars]
    glm_trunc = glm_content[:max_chars]

    if len(std_content) > max_chars:
        std_trunc += f"\n\n... [截断，原文共 {len(std_content)} 字符]"
    if len(glm_content) > max_chars:
        glm_trunc += f"\n\n... [截断，原文共 {len(glm_content)} 字符]"

    messages = [
        {"role": "system", "content": EVAL_PROMPT},
        {"role": "user", "content": f"""## 文档: {doc_name}

### OCR 系统A输出（Standard Pipeline - RapidOCR）:
```
{std_trunc}
```

### OCR 系统B输出（GLM-OCR VLM）:
```
{glm_trunc}
```

请评估这两个 OCR 系统的输出质量。"""},
    ]

    print(f"  Sending to {MODEL} for evaluation...", flush=True)
    start = time.time()
    response = call_qwen(api_key, messages)
    elapsed = time.time() - start
    print(f"  Response received in {elapsed:.1f}s", flush=True)

    # Extract JSON from response
    try:
        # Try to find JSON in code block
        import re
        json_match = re.search(r"```json\s*(.*?)\s*```", response, re.DOTALL)
        if json_match:
            result = json.loads(json_match.group(1))
        else:
            result = json.loads(response)
    except json.JSONDecodeError:
        print(f"  WARNING: Could not parse JSON from response")
        print(f"  Raw response: {response[:500]}")
        result = {"raw_response": response}

    result["_meta"] = {
        "model": MODEL,
        "doc_name": doc_name,
        "std_chars": len(std_content),
        "glm_chars": len(glm_content),
        "eval_time_s": elapsed,
    }

    return result


def run_auto_eval(api_key: str, docs: list[str]):
    """Run full pipeline: parse with both modes, then evaluate."""
    sys.path.insert(0, str(Path(__file__).parent))
    import parser as docling_parser
    from docling.datamodel.settings import settings

    settings.perf.page_batch_size = 8

    all_results = []

    for doc_path in docs:
        doc_name = Path(doc_path).name
        print(f"\n{'='*60}")
        print(f"Processing: {doc_name}")
        print(f"{'='*60}")

        # Standard pipeline
        print("  [1/3] Standard pipeline...", flush=True)
        docling_parser._converter_cache.clear()
        std_result = docling_parser.parse_document_sync(doc_path, {
            "model_config": {
                "use_vlm": False,
                "artifacts_path": "data/models/docling",
            }
        })
        std_content = std_result["content"]
        print(f"  Standard: {len(std_content)} chars, {std_result['metadata'].get('page_count', '?')} pages")

        # GLM-OCR pipeline
        print("  [2/3] GLM-OCR pipeline...", flush=True)
        docling_parser._converter_cache.clear()
        glm_result = docling_parser.parse_document_sync(doc_path, {
            "model_config": {
                "use_vlm": True,
                "vlm_model": "zai-org/GLM-OCR",
                "vlm_mode": "inline",
                "artifacts_path": "data/models/docling",
            }
        })
        glm_content = glm_result["content"]
        print(f"  GLM-OCR: {len(glm_content)} chars")

        # Evaluate
        print("  [3/3] Evaluating with qwen3.6-plus...", flush=True)
        eval_result = evaluate_pair(api_key, std_content, glm_content, doc_name)
        all_results.append(eval_result)

    return all_results


def print_results(results: list[dict]):
    """Print formatted evaluation results."""
    print(f"\n{'='*70}")
    print("EVALUATION RESULTS SUMMARY")
    print(f"{'='*70}")

    for r in results:
        meta = r.get("_meta", {})
        doc = meta.get("doc_name", "unknown")
        print(f"\n--- {doc} (Standard: {meta.get('std_chars',0)} chars, GLM: {meta.get('glm_chars',0)} chars) ---")

        for system in ["standard", "glm_ocr"]:
            if system in r:
                s = r[system]
                if isinstance(s, dict) and "total" in s:
                    print(f"  {system:12s}: text={s.get('text_accuracy','?')}/10  "
                          f"structure={s.get('structure','?')}/10  "
                          f"format={s.get('format','?')}/10  "
                          f"complete={s.get('completeness','?')}/10  "
                          f"readable={s.get('readability','?')}/10  "
                          f"TOTAL={s.get('total','?')}/50")
                    if s.get("strengths"):
                        print(f"    Strengths: {s['strengths']}")
                    if s.get("weaknesses"):
                        print(f"    Weaknesses: {s['weaknesses']}")

        if r.get("winner"):
            print(f"  Winner: {r['winner']}")
        if r.get("summary"):
            print(f"  Summary: {r['summary']}")

    # Overall comparison
    std_totals = []
    glm_totals = []
    for r in results:
        if "standard" in r and isinstance(r["standard"], dict):
            std_totals.append(r["standard"].get("total", 0))
        if "glm_ocr" in r and isinstance(r["glm_ocr"], dict):
            glm_totals.append(r["glm_ocr"].get("total", 0))

    if std_totals and glm_totals:
        print(f"\n{'='*70}")
        print(f"OVERALL: Standard avg={sum(std_totals)/len(std_totals):.1f}/50, "
              f"GLM-OCR avg={sum(glm_totals)/len(glm_totals):.1f}/50")
        if sum(std_totals) > sum(glm_totals):
            print("OVERALL WINNER: Standard Pipeline (RapidOCR)")
        elif sum(glm_totals) > sum(std_totals):
            print("OVERALL WINNER: GLM-OCR (VLM)")
        else:
            print("OVERALL: TIE")


def main():
    ap = argparse.ArgumentParser(description="OCR accuracy evaluator using qwen3.6-plus")
    ap.add_argument("--api-key", default=os.environ.get("DASHSCOPE_API_KEY", ""))
    ap.add_argument("--auto", action="store_true", help="Run full pipeline + evaluate")
    ap.add_argument("--docs", nargs="+", default=[
        "/mnt/d/testdata/pdf/kb/BDCC-08-00115.pdf",
        "/mnt/d/testdata/pdf/kb/antigravity-rag-2026.pdf",
        "/mnt/d/testdata/pdf/记忆论文/sukhbaatar21a.pdf",
    ])
    ap.add_argument("--std", help="Standard pipeline markdown file")
    ap.add_argument("--glm", help="GLM-OCR markdown file")
    ap.add_argument("--save", default="/tmp/ocr_eval_results.json", help="Save results to file")
    args = ap.parse_args()

    if not args.api_key:
        print("ERROR: Set DASHSCOPE_API_KEY environment variable or pass --api-key")
        sys.exit(1)

    if args.auto:
        results = run_auto_eval(args.api_key, args.docs)
    elif args.std and args.glm:
        std_content = Path(args.std).read_text()
        glm_content = Path(args.glm).read_text()
        doc_name = Path(args.std).stem
        result = evaluate_pair(args.api_key, std_content, glm_content, doc_name)
        results = [result]
    else:
        # Use pre-generated files
        print("Using pre-generated outputs from /tmp/")
        results = []
        for f in [("/tmp/std_output.md", "/tmp/glm_output_v2.md", "BDCC-08-00115")]:
            std_path, glm_path, name = f
            if Path(std_path).exists() and Path(glm_path).exists():
                std_content = Path(std_path).read_text()
                glm_content = Path(glm_path).read_text()
                print(f"\nEvaluating: {name}")
                result = evaluate_pair(args.api_key, std_content, glm_content, name)
                results.append(result)
            else:
                print(f"SKIP: {std_path} or {glm_path} not found")

    print_results(results)

    # Save results
    with open(args.save, "w") as f:
        json.dump(results, f, indent=2, ensure_ascii=False)
    print(f"\nResults saved to {args.save}")


if __name__ == "__main__":
    main()
