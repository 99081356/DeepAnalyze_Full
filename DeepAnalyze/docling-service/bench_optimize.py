"""GLM-OCR optimization benchmark — tests multiple config variants."""
from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import parser as dp
from docling.datamodel.settings import settings
from docling.datamodel.pipeline_options_vlm_model import (
    InlineVlmOptions,
    InferenceFramework,
    TransformersModelType,
    TransformersPromptStyle,
    ResponseFormat,
)

settings.perf.page_batch_size = 8

DOC = "/mnt/d/testdata/pdf/kb/BDCC-08-00115.pdf"


def make_options(label: str, **overrides) -> dict:
    """Build model_config with optional InlineVlmOptions overrides."""
    base = InlineVlmOptions(
        repo_id="zai-org/GLM-OCR",
        prompt="Text Recognition:",
        inference_framework=InferenceFramework.TRANSFORMERS,
        response_format=ResponseFormat.MARKDOWN,
        transformers_model_type=TransformersModelType.AUTOMODEL_IMAGETEXTTOTEXT,
        transformers_prompt_style=TransformersPromptStyle.CHAT,
        torch_dtype="bfloat16",
        load_in_8bit=False,
        scale=2.0,
        max_new_tokens=4096,
    )
    for k, v in overrides.items():
        setattr(base, k, v)

    from docling.document_converter import DocumentConverter, PdfFormatOption
    from docling.datamodel.pipeline_options import VlmPipelineOptions
    from docling.pipeline.vlm_pipeline import VlmPipeline

    artifacts = "data/models/docling/vlm"
    pipeline_options = VlmPipelineOptions(
        artifacts_path=artifacts,
        vlm_options=base,
    )
    converter = DocumentConverter(
        format_options={
            "pdf": PdfFormatOption(
                pipeline_cls=VlmPipeline,
                pipeline_options=pipeline_options,
            ),
        },
    )
    return {"label": label, "converter": converter}


def run_test(converter, label):
    dp._converter_cache.clear()
    # Replace cache entry with our custom converter
    import hashlib, json
    # Use a unique key for each test
    cache_key = f"bench_{label}"
    dp._converter_cache[cache_key] = converter

    # Patch to use our converter directly
    t0 = time.time()
    result = converter.convert(DOC)
    elapsed = time.time() - t0

    content = result.document.export_to_markdown()
    # Apply post-processing like the real pipeline
    from parser import _clean_vlm_output, _restore_document_structure
    content = _clean_vlm_output(content)
    content = _restore_document_structure(content)

    pages = len(result.pages)
    headings = len([l for l in content.split("\n") if l.startswith("#")])
    import re
    artifacts = len(re.findall(r"&lt;\|\w+", content))

    print(f"  [{label}] {elapsed:.1f}s | {len(content)} chars | {headings} headings | {artifacts} artifacts | {pages} pages")
    return {"label": label, "time": elapsed, "chars": len(content),
            "headings": headings, "artifacts": artifacts, "pages": pages}


print(f"GLM-OCR Optimization Benchmark — {Path(DOC).name}")
print(f"GPU: RTX 5090 Laptop, batch_size=8")
print(f"{'='*60}")

# Test 1: Baseline (current config)
print("\n[1/3] Baseline (current config)...")
import torch
torch.cuda.empty_cache()
opt1 = make_options("baseline")
r1 = run_test(opt1["converter"], opt1["label"])

# Test 2: + stop_strings (early stopping on <|user token)
print("\n[2/3] + stop_strings...")
dp._converter_cache.clear()
torch.cuda.empty_cache()
opt2 = make_options("stop_strings", stop_strings=["<|user"])
r2 = run_test(opt2["converter"], opt2["label"])

# Test 3: + stop_strings + max_new_tokens=2048
print("\n[3/3] + stop_strings + max_new_tokens=2048...")
dp._converter_cache.clear()
torch.cuda.empty_cache()
opt3 = make_options("stop+2k", stop_strings=["<|user"], max_new_tokens=2048)
r3 = run_test(opt3["converter"], opt3["label"])

# Summary
print(f"\n{'='*60}")
print(f"{'Variant':<20} {'Time':>6} {'Chars':>8} {'Heads':>6} {'Artifacts':>10}")
print(f"{'-'*20} {'-'*6} {'-'*8} {'-'*6} {'-'*10}")
for r in [r1, r2, r3]:
    print(f"{r['label']:<20} {r['time']:>5.1f}s {r['chars']:>8} {r['headings']:>6} {r['artifacts']:>10}")

baseline_time = r1["time"]
print(f"\nSpeedup vs baseline:")
for r in [r2, r3]:
    pct = (baseline_time - r["time"]) / baseline_time * 100
    char_diff = (r["chars"] - r1["chars"]) / r1["chars"] * 100
    print(f"  {r['label']:<20} {pct:>+.1f}% time, {char_diff:>+.1f}% chars")
