"""
Document parser module using Docling.

Provides the parse_document function which converts a document file into
structured data (markdown content, tables, images, metadata).

Supports dynamic model selection via model_config:
  - layout_model:  repo_id or local path for layout detection
  - ocr_engine:    "rapidocr" | "easyocr" | "tesseract"
  - ocr_backend:   "torch" | "onnxruntime"  (RapidOCR only)
  - ocr_lang:      language list e.g. ["chinese", "english"]
  - table_mode:    "accurate" | "fast"
  - use_vlm:       boolean
  - vlm_model:     repo_id for VLM model
  - vlm_mode:      "inline" (load into Docling process) | "api" (standalone service)
  - vlm_api_url:   URL for the VLM API service (api mode only)
  - artifacts_path: local model root directory
"""

from __future__ import annotations

import json
import logging
import re
import threading
from typing import Any

logging.basicConfig(level=logging.INFO)
_log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Converter cache (keyed by config hash) — thread-safe
# ---------------------------------------------------------------------------

_converter_cache: dict[str, Any] = {}
_cache_lock = threading.Lock()


def _config_hash(cfg: dict) -> str:
    """Produce a stable hash from a model config dict for caching."""
    return json.dumps(cfg, sort_keys=True)


def _get_converter(model_config: dict):
    """Build (or retrieve cached) DocumentConverter from a model_config dict.

    Thread-safe: uses _cache_lock to protect the cache.

    model_config keys:
      - artifacts_path (str): Local model root directory (data/models/docling)
      - layout_model   (str): repo_id e.g. "docling-project/docling-layout-egret-xlarge"
      - ocr_engine     (str): "rapidocr" | "easyocr" | "tesseract"
      - ocr_backend    (str): "torch" | "onnxruntime"
      - ocr_lang       (list[str]): e.g. ["chinese", "english"]
      - table_mode     (str): "accurate" | "fast"
      - use_vlm        (bool): Whether to use VLM pipeline
      - vlm_model      (str): VLM repo_id e.g. "PaddlePaddle/PaddleOCR-VL-1.5"
      - vlm_mode       (str): "inline" | "api"
      - vlm_api_url    (str): API URL for VLM service (api mode only)
    """
    cache_key = _config_hash(model_config)
    with _cache_lock:
        if cache_key in _converter_cache:
            return _converter_cache[cache_key]

    # Build outside the lock (expensive operation)
    use_vlm = model_config.get("use_vlm", False)
    if use_vlm:
        converter = _build_vlm_converter(model_config)
    else:
        converter = _build_standard_converter(model_config)

    with _cache_lock:
        _converter_cache[cache_key] = converter
    return converter


def _resolve_layout_model_spec(model_config: dict):
    """Resolve the layout model spec from model_config.

    Returns a LayoutModelConfig instance from docling's built-in specs,
    or constructs one for a custom model repo_id.
    """
    from docling.datamodel.layout_model_specs import (
        DOCLING_LAYOUT_EGRET_XLARGE,
        DOCLING_LAYOUT_HERON,
        LayoutModelConfig,
    )

    layout_model = model_config.get("layout_model", "docling-project/docling-layout-egret-xlarge")

    # Map repo_id to built-in spec
    spec_map = {
        "docling-project/docling-layout-egret-xlarge": DOCLING_LAYOUT_EGRET_XLARGE,
        "docling-project/docling-layout-heron": DOCLING_LAYOUT_HERON,
    }

    spec = spec_map.get(layout_model)

    if spec is None:
        # Custom/unknown model — construct a LayoutModelConfig
        spec = LayoutModelConfig(
            name=layout_model.split("/")[-1],
            repo_id=layout_model,
            revision="main",
            model_path="",
        )
        _log.info("Using custom layout model: %s", layout_model)

    return spec


def _build_standard_converter(model_config: dict):
    """Build a standard-pipeline DocumentConverter from model_config."""
    import os
    from docling.document_converter import DocumentConverter, PdfFormatOption
    from docling.datamodel.pipeline_options import (
        PdfPipelineOptions,
        TableFormerMode,
    )

    pipeline_options = PdfPipelineOptions()

    # --- Artifacts path ---
    # docling expects: artifacts_path/<org>--<model>/
    # Our directory structure is: data/models/docling/layout/<org>--<model>/
    # Set artifacts_path only if the layout subdirectory exists and contains models.
    artifacts_path = model_config.get("artifacts_path", "")
    if artifacts_path and os.path.isdir(artifacts_path):
        # Check if models exist directly under artifacts_path (flat layout)
        # or under subdirectories (category layout)
        layout_dir = os.path.join(artifacts_path, "layout")
        if os.path.isdir(layout_dir):
            # Category layout — don't set artifacts_path on pipeline_options
            # because docling expects flat structure. Rely on HF cache instead.
            _log.info("Category-based model layout detected at %s, using HF cache", artifacts_path)
        else:
            # Flat layout — docling can use this directly
            pipeline_options.artifacts_path = artifacts_path
            _log.info("Using local artifacts path: %s", artifacts_path)

    # --- Layout model ---
    layout_spec = _resolve_layout_model_spec(model_config)
    if layout_spec is not None:
        pipeline_options.layout_options.model_spec = layout_spec

    # --- OCR engine ---
    ocr_engine = model_config.get("ocr_engine", "rapidocr")
    ocr_backend = model_config.get("ocr_backend", "torch")
    ocr_lang = model_config.get("ocr_lang", ["chinese", "english"])

    if ocr_engine == "rapidocr":
        from docling.datamodel.pipeline_options import RapidOcrOptions
        pipeline_options.ocr_options = RapidOcrOptions(
            lang=ocr_lang,
            backend=ocr_backend,
            text_score=0.5,
        )
    elif ocr_engine == "easyocr":
        from docling.datamodel.pipeline_options import EasyOcrOptions
        pipeline_options.ocr_options = EasyOcrOptions(lang=ocr_lang)
    elif ocr_engine == "tesseract":
        from docling.datamodel.pipeline_options import TesseractOcrOptions
        pipeline_options.ocr_options = TesseractOcrOptions(lang=ocr_lang)

    # --- Table mode ---
    table_mode = model_config.get("table_mode", "accurate")
    if table_mode == "accurate":
        pipeline_options.table_structure_options.mode = TableFormerMode.ACCURATE
    else:
        pipeline_options.table_structure_options.mode = TableFormerMode.FAST

    # --- Page images for downstream use ---
    pipeline_options.generate_page_images = True

    converter = DocumentConverter(
        format_options={
            "pdf": PdfFormatOption(
                pipeline_options=pipeline_options,
            ),
        },
    )

    return converter


def _build_vlm_converter(model_config: dict):
    """Build a VLM-pipeline DocumentConverter from model_config.

    Supports two modes:
      - "inline": Load VLM directly into the Docling process via Transformers
      - "api":     Call a standalone PaddleOCR-VL service via OpenAI-compatible API
    """
    import os
    from docling.document_converter import DocumentConverter, PdfFormatOption
    from docling.datamodel.pipeline_options import VlmPipelineOptions
    from docling.pipeline.vlm_pipeline import VlmPipeline
    from docling.datamodel.settings import settings

    # Optimize GPU batch size for VLM inference.
    # Benchmarked: batch_size=8 gives ~12% speedup over default 4 on RTX 5090.
    # Larger batches (15+) are slower due to autoregressive decoding overhead.
    settings.perf.page_batch_size = 8

    vlm_model = model_config.get("vlm_model", "PaddlePaddle/PaddleOCR-VL-1.5")
    vlm_mode = model_config.get("vlm_mode", "inline")

    # --- Resolve artifacts_path for VLM models ---
    artifacts_path = model_config.get("artifacts_path", "")
    if artifacts_path:
        vlm_artifacts = os.path.join(artifacts_path, "vlm")
        if not os.path.isdir(vlm_artifacts):
            vlm_artifacts = artifacts_path
    else:
        vlm_artifacts = None

    if vlm_mode == "api":
        vlm_options = _build_api_vlm_options(model_config)
        _log.info("Using VLM API mode: url=%s", vlm_options.url if hasattr(vlm_options, 'url') else 'unknown')
    else:
        vlm_options = _build_inline_vlm_options(vlm_model, vlm_artifacts)
        _log.info("Using VLM inline mode: model=%s", vlm_model)

    pipeline_options = VlmPipelineOptions(
        artifacts_path=vlm_artifacts,
        vlm_options=vlm_options,
    )

    converter = DocumentConverter(
        format_options={
            "pdf": PdfFormatOption(
                pipeline_cls=VlmPipeline,
                pipeline_options=pipeline_options,
            ),
        },
    )
    return converter


def _build_inline_vlm_options(vlm_model: str, artifacts_path: str | None):
    """Build InlineVlmOptions for loading VLM directly into the process."""
    from docling.datamodel.pipeline_options_vlm_model import (
        InlineVlmOptions,
        InferenceFramework,
        TransformersModelType,
        TransformersPromptStyle,
        ResponseFormat,
    )

    # PaddleOCR-VL-1.5 specific configuration
    if vlm_model in ("PaddlePaddle/PaddleOCR-VL-1.5", "PaddleOCR-VL-1.5"):
        return InlineVlmOptions(
            repo_id="PaddlePaddle/PaddleOCR-VL-1.5",
            prompt="请识别并提取图片中的所有文字内容，保持原始布局和格式。",
            inference_framework=InferenceFramework.TRANSFORMERS,
            response_format=ResponseFormat.MARKDOWN,
            transformers_model_type=TransformersModelType.AUTOMODEL_CAUSALLM,
            transformers_prompt_style=TransformersPromptStyle.CHAT,
            trust_remote_code=True,
            torch_dtype="bfloat16",
            max_new_tokens=8192,
            load_in_8bit=False,
            scale=1.5,
            extra_generation_config={
                "skip_special_tokens": True,
            },
        )

    # GLM-OCR configuration (Docling native support since v2.84.0)
    # Uses official prompt "Text Recognition:" — the model is a dedicated OCR
    # model, not a document structure analyzer. Headings are recovered via
    # _restore_document_structure() post-processing.
    if vlm_model in ("zai-org/GLM-OCR", "GLM-OCR", "glm-ocr"):
        return InlineVlmOptions(
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

    # Generic VLM model configuration
    return InlineVlmOptions(
        repo_id=vlm_model,
        prompt="Convert this page to docling.",
        inference_framework=InferenceFramework.TRANSFORMERS,
        response_format=ResponseFormat.MARKDOWN,
        transformers_model_type=TransformersModelType.AUTOMODEL_IMAGETEXTTOTEXT,
        transformers_prompt_style=TransformersPromptStyle.CHAT,
        trust_remote_code=True,
    )


def _build_api_vlm_options(model_config: dict):
    """Build ApiVlmOptions for calling a standalone VLM service."""
    from docling.datamodel.pipeline_options_vlm_model import (
        ApiVlmOptions,
        ResponseFormat,
    )

    vlm_api_url = model_config.get(
        "vlm_api_url",
        "http://localhost:8600/v1/chat/completions",
    )
    vlm_model = model_config.get("vlm_model", "PaddlePaddle/PaddleOCR-VL-1.5")

    return ApiVlmOptions(
        url=vlm_api_url,
        prompt="请识别并提取图片中的所有文字内容，保持原始布局和格式。",
        response_format=ResponseFormat.MARKDOWN,
        timeout=120.0,
        concurrency=3,
    )


# Regex to strip PaddleOCR-VL location tokens: <|LOC_123|>
# Both raw and HTML-encoded variants
_LOC_TOKEN_RE = re.compile(r"(?:<\|LOC_\d+\|>|&lt;\|LOC_\d+\|&gt;)")

# Regex to strip partial special tokens that leak from VLM models:
# - GLM-OCR emits &lt;|user at page boundaries (HTML-encoded <|user)
# - Also handle raw variant and any partial tokens like <|user|>, <|assistant| etc.
_VLM_ARTIFACT_RE = re.compile(r"&lt;\|\w+(?:\|&gt;)?|<\|\w+\|>")


def _clean_vlm_output(text: str) -> str:
    """Remove VLM-specific special tokens from output text.

    Handles:
    - PaddleOCR-VL-1.5 <|LOC_xx|> location tokens
    - GLM-OCR &lt;|user partial tokens at page boundaries
    - Any other VLM special token artifacts
    """
    cleaned = _LOC_TOKEN_RE.sub("", text)
    cleaned = _VLM_ARTIFACT_RE.sub("", cleaned)
    # Collapse multiple consecutive blank lines to at most two
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()


# Patterns for detecting section headings in OCR output where the VLM model
# does not produce markdown heading markers (##) itself.
#
# Pattern 1: "1. Introduction" or "3.2. Retriever" (numbered sections)
# Pattern 2: "References" or "Bibliography" (common section names at start of line)
_HEADING_NUM_RE = re.compile(
    r"^(\d+(?:\.\d+)*)\.?\s+(.{2,80})$",
    re.MULTILINE,
)
_KNOWN_SECTIONS = {
    "abstract", "introduction", "background", "related work",
    "methodology", "methods", "materials and methods", "experiments",
    "results", "discussion", "conclusion", "conclusions",
    "references", "bibliography", "acknowledgments", "acknowledgements",
    "appendix", "summary", "future work", "limitations",
}


def _restore_document_structure(text: str) -> str:
    """Post-process VLM output to restore markdown heading markers.

    GLM-OCR outputs section headings as plain text (e.g., "1. Introduction")
    without markdown heading syntax (##). This function detects such patterns
    and adds appropriate heading levels based on the section number depth.
    """
    lines = text.split("\n")
    result: list[str] = []

    for line in lines:
        stripped = line.strip()

        # Check for numbered section pattern: "1. Introduction", "3.2. Retriever"
        m = _HEADING_NUM_RE.match(stripped)
        if m:
            num_part = m.group(1)
            title_part = m.group(2).strip()

            # Count heading depth: "1" -> 2, "3.2" -> 3, "4.1.2" -> 4
            depth = num_part.count(".") + 2
            depth = min(depth, 4)  # cap at ####

            # Only treat as heading if the title looks like a real heading
            # (not just a numbered list item or sentence)
            if (
                title_part
                and not title_part.startswith(("-", "*", "•", "·"))
                and len(title_part) > 2
                and len(title_part) < 80
                and not title_part.endswith(".")
                and (
                    title_part[0].isupper()
                    or title_part[0] in ("'", '"')
                    or any(c.isalpha() for c in title_part[:3])
                )
            ):
                result.append(f"{'#' * depth} {stripped}")
                continue

        # Check for known section names (unnumbered)
        if stripped and stripped.lower() in _KNOWN_SECTIONS:
            result.append(f"## {stripped}")
            continue

        result.append(line)

    return "\n".join(result)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

async def parse_document(file_path: str, options: dict | None = None) -> dict[str, Any]:
    """Parse a document using Docling and return a structured result.

    This is the async version kept for backward compatibility.
    For thread pool usage, prefer parse_document_sync().
    """
    return parse_document_sync(file_path, options)


def parse_document_sync(file_path: str, options: dict | None = None) -> dict[str, Any]:
    """Synchronous document parsing — safe to call from thread pool executor.

    Args:
        file_path: Absolute or relative path to the document file.
        options: Optional dictionary with parsing hints.
            - ocr (bool): Whether to enable OCR. Defaults to True.
            - extract_tables (bool): Whether to extract table data. Defaults to True.
            - use_vlm (bool): Use VLM pipeline for highest quality.
            - model_config (dict): Dynamic model configuration.

    Returns:
        A dictionary with keys: content, tables, images, metadata, raw, doctags.
    """
    if options is None:
        options = {}

    model_config = options.get("model_config", {})

    # Merge use_vlm from top-level options into model_config
    if "use_vlm" in options and "use_vlm" not in model_config:
        model_config["use_vlm"] = options["use_vlm"]

    # Apply defaults if model_config is empty (backward compat)
    if not model_config:
        model_config = {
            "layout_model": "docling-project/docling-layout-egret-xlarge",
            "ocr_engine": "rapidocr",
            "ocr_backend": "torch",
            "ocr_lang": ["chinese", "english"],
            "table_mode": "accurate",
            "use_vlm": False,
            "vlm_model": "zai-org/GLM-OCR",
            "vlm_mode": "inline",
        }

    use_vlm = model_config.get("use_vlm", False)
    if use_vlm:
        vlm_mode = model_config.get("vlm_mode", "inline")
        _log.info("Using VLM pipeline (%s, mode=%s) for %s",
                  model_config.get("vlm_model", "default"), vlm_mode, file_path)
    else:
        _log.info("Using standard pipeline (layout=%s, ocr=%s) for %s",
                  model_config.get("layout_model", "default"),
                  model_config.get("ocr_engine", "rapidocr"),
                  file_path)

    converter = _get_converter(model_config)
    result = converter.convert(file_path)

    # Export to markdown
    markdown_content = result.document.export_to_markdown()

    # Post-process: clean VLM-specific tokens from output
    # PaddleOCR-VL emits <|LOC_xx|> location tokens that need stripping
    if use_vlm:
        markdown_content = _clean_vlm_output(markdown_content)
        # Restore document structure (headings) lost during VLM OCR
        markdown_content = _restore_document_structure(markdown_content)

    # Extract tables
    tables: list[dict[str, Any]] = []
    try:
        for table in result.document.tables:
            tables.append(
                {
                    "data": table.export_to_dataframe(doc=result.document).to_csv(),
                    "page": (
                        getattr(table.prov, "page_no", None)
                        if table.prov
                        else None
                    ),
                }
            )
    except Exception as exc:
        _log.warning("Failed to extract some tables: %s", exc)

    # Extract image references
    images: list[dict[str, Any]] = []
    try:
        for pic in result.document.pictures:
            caption: str | None = None
            if pic.captions:
                try:
                    caption = pic.caption_text(result.document)
                except Exception:
                    caption = None
            images.append(
                {
                    "caption": caption,
                    "page": (
                        getattr(pic.prov, "page_no", None)
                        if pic.prov
                        else None
                    ),
                }
            )
    except Exception as exc:
        _log.warning("Failed to extract some images: %s", exc)

    # Metadata
    metadata: dict[str, Any] = {
        "page_count": len(result.pages) if hasattr(result, "pages") else None,
        "format": str(result.input.format) if hasattr(result, "input") else None,
    }

    return {
        "content": markdown_content,
        "tables": tables,
        "images": images,
        "metadata": metadata,
        "raw": result.document.export_to_dict(),
        "doctags": result.document.export_to_doctags(),
        "doctagsAvailable": True,
    }
