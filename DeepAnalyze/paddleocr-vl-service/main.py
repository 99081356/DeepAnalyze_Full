#!/usr/bin/env python3
"""
PaddleOCR-VL-1.5 Standalone Inference Service.

Provides an OpenAI-compatible /v1/chat/completions endpoint for document OCR.
Loads the model once at startup and serves requests via FastAPI.

Usage:
    python main.py
    # Or with uvicorn:
    uvicorn main:app --host 0.0.0.0 --port 8600

Environment variables:
    MODEL_PATH    - Local path or HuggingFace repo ID (default: PaddlePaddle/PaddleOCR-VL-1.5)
    PORT          - Server port (default: 8600)
    TORCH_DTYPE   - Model precision: bfloat16 | float16 | float32 (default: bfloat16)
    MAX_TOKENS    - Max new tokens per request (default: 8192)
"""

from __future__ import annotations

import base64
import io
import logging
import os
import time
from typing import Any

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from PIL import Image

logging.basicConfig(level=logging.INFO)
_log = logging.getLogger("paddleocr-vl")

# ---------------------------------------------------------------------------
# Global model state
# ---------------------------------------------------------------------------

_model = None
_processor = None
_device = None
_config: dict[str, Any] = {}

MODEL_PATH = os.environ.get("MODEL_PATH", "PaddlePaddle/PaddleOCR-VL-1.5")
TORCH_DTYPE = os.environ.get("TORCH_DTYPE", "bfloat16")
MAX_TOKENS = int(os.environ.get("MAX_TOKENS", "8192"))
DEFAULT_PROMPT = "请识别并提取图片中的所有文字内容，保持原始布局和格式。"


def _resolve_model_path() -> str:
    """Resolve model path, checking local data/models directory first."""
    if os.path.isdir(MODEL_PATH):
        return MODEL_PATH

    # Check common local paths
    candidates = [
        os.path.join("data", "models", "docling", "vlm", "PaddlePaddle--PaddleOCR-VL-1.5"),
        os.path.join("..", "data", "models", "docling", "vlm", "PaddlePaddle--PaddleOCR-VL-1.5"),
    ]
    for c in candidates:
        if os.path.isdir(c):
            _log.info("Using local model at: %s", c)
            return c

    return MODEL_PATH


def load_model() -> None:
    """Load the PaddleOCR-VL model and processor into memory."""
    global _model, _processor, _device, _config

    import torch
    from transformers import AutoModelForCausalLM, AutoProcessor

    model_path = _resolve_model_path()
    dtype_map = {
        "bfloat16": torch.bfloat16,
        "float16": torch.float16,
        "float32": torch.float32,
    }
    torch_dtype = dtype_map.get(TORCH_DTYPE, torch.bfloat16)
    _device = "cuda" if torch.cuda.is_available() else "cpu"

    _log.info("Loading PaddleOCR-VL-1.5 from %s (dtype=%s, device=%s)", model_path, TORCH_DTYPE, _device)
    start = time.time()

    _processor = AutoProcessor.from_pretrained(
        model_path,
        trust_remote_code=True,
        use_fast=True,
    )

    _model = AutoModelForCausalLM.from_pretrained(
        model_path,
        dtype=torch_dtype,
        trust_remote_code=True,
    ).to(_device).eval()

    elapsed = time.time() - start
    _log.info("Model loaded in %.1fs", elapsed)

    _config = {
        "model": MODEL_PATH,
        "dtype": TORCH_DTYPE,
        "device": str(_device),
        "max_tokens": MAX_TOKENS,
    }


app = FastAPI(
    title="PaddleOCR-VL Service",
    description="OpenAI-compatible VLM inference service for document OCR",
    version="1.0.0",
)


@app.on_event("startup")
async def startup():
    load_model()


# ---------------------------------------------------------------------------
# OpenAI-compatible endpoints
# ---------------------------------------------------------------------------


@app.get("/v1/models")
async def list_models():
    return {
        "object": "list",
        "data": [
            {
                "id": "paddleocr-vl-1.5",
                "object": "model",
                "owned_by": "paddlepaddle",
            }
        ],
    }


@app.post("/v1/chat/completions")
async def chat_completions(request: dict[str, Any]):
    """OpenAI-compatible chat completions endpoint.

    Expects messages with image_url content parts (base64 data URLs).
    """
    if _model is None:
        raise HTTPException(status_code=503, detail="Model not loaded")

    messages = request.get("messages", [])
    if not messages:
        raise HTTPException(status_code=400, detail="No messages provided")

    # Extract text prompt and images from messages
    prompt = DEFAULT_PROMPT
    images: list[Image.Image] = []

    for msg in messages:
        content = msg.get("content", "")
        if isinstance(content, str):
            if msg.get("role") == "user" and content:
                prompt = content
        elif isinstance(content, list):
            for part in content:
                if isinstance(part, dict):
                    if part.get("type") == "text":
                        text = part.get("text", "")
                        if text:
                            prompt = text
                    elif part.get("type") == "image_url":
                        url = part.get("image_url", {}).get("url", "")
                        if url.startswith("data:image"):
                            # Decode base64 data URL
                            b64_data = url.split(",", 1)[1]
                            img_bytes = base64.b64decode(b64_data)
                            images.append(Image.open(io.BytesIO(img_bytes)).convert("RGB"))

    if not images:
        raise HTTPException(status_code=400, detail="No image provided in messages")

    # Run inference
    import torch

    try:
        # Build conversation using chat template
        conversation = [
            {"role": "user", "content": [{"type": "image"}, {"type": "text", "text": prompt}]}
        ]
        text_input = _processor.apply_chat_template(conversation, add_generation_prompt=True)

        inputs = _processor(
            text=[text_input],
            images=[images[0]],
            return_tensors="pt",
        ).to(_device)

        max_tokens = request.get("max_tokens", MAX_TOKENS)
        temperature = request.get("temperature", 0.0)

        gen_kwargs = {
            "max_new_tokens": max_tokens,
            "do_sample": temperature > 0,
        }
        if temperature > 0:
            gen_kwargs["temperature"] = temperature

        with torch.inference_mode():
            output_ids = _model.generate(**inputs, **gen_kwargs)

        # Decode only the new tokens
        input_len = inputs["input_ids"].shape[1]
        generated_ids = output_ids[0, input_len:]
        result_text = _processor.decode(generated_ids, skip_special_tokens=True).strip()

        # Strip PaddleOCR-VL location tokens (<|LOC_xx|>)
        import re
        result_text = re.sub(r"<\|LOC_\d+\|>", "", result_text).strip()
        result_text = re.sub(r"\n{3,}", "\n\n", result_text)

    except Exception as exc:
        _log.error("Inference failed: %s", exc)
        raise HTTPException(status_code=500, detail=f"Inference error: {exc}") from exc

    # Format response as OpenAI chat completion
    request_id = f"chatcmpl-{int(time.time() * 1000)}"
    return {
        "id": request_id,
        "object": "chat.completion",
        "created": int(time.time()),
        "model": "paddleocr-vl-1.5",
        "choices": [
            {
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": result_text,
                },
                "finish_reason": "stop",
            }
        ],
        "usage": {
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
        },
    }


# ---------------------------------------------------------------------------
# Health / status endpoints
# ---------------------------------------------------------------------------


@app.get("/health")
async def health():
    return {
        "status": "ok" if _model is not None else "loading",
        "model": _config,
    }


@app.get("/")
async def root():
    return {"service": "paddleocr-vl", "version": "1.0.0", "status": "ok" if _model is not None else "loading"}


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8600"))
    uvicorn.run(app, host="0.0.0.0", port=port)
