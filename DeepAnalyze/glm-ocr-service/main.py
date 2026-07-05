"""GLM-OCR FastAPI service — exposes /predict for OCR on images.

Mirrors paddleocr-vl-service/main.py API shape so the docling-service
parser can switch between backends with minimal code changes.
"""
from __future__ import annotations

import argparse
import base64
import os
import sys
from typing import Any

import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

# Lazy load torch + model — keep startup fast until first request
_MODEL = None
_PROCESSOR = None
_DEVICE = None


class PredictRequest(BaseModel):
    image_base64: str
    max_tokens: int = 4096


class PredictResponse(BaseModel):
    text: str
    usage: dict[str, Any]


app = FastAPI(title="DeepAnalyze GLM-OCR Service")


def _load_model() -> None:
    global _MODEL, _PROCESSOR, _DEVICE
    if _MODEL is not None:
        return
    import torch
    from transformers import AutoModel, AutoProcessor

    model_path = os.environ.get("MODEL_PATH", "/app/models/docling/vlm/zai-org--GLM-OCR")
    _DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
    _PROCESSOR = AutoProcessor.from_pretrained(model_path, trust_remote_code=True)
    _MODEL = AutoModel.from_pretrained(
        model_path,
        torch_dtype=torch.bfloat16 if _DEVICE == "cuda" else torch.float32,
        trust_remote_code=True,
    ).to(_DEVICE)
    _MODEL.eval()


@app.get("/health")
def health() -> dict[str, Any]:
    return {"status": "ok", "device": _DEVICE or "unloaded"}


@app.post("/predict", response_model=PredictResponse)
def predict(req: PredictRequest) -> PredictResponse:
    _load_model()
    import torch
    from PIL import Image
    import io

    try:
        img_bytes = base64.b64decode(req.image_base64)
        image = Image.open(io.BytesIO(img_bytes)).convert("RGB")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"invalid image: {exc}")

    # GLM-OCR processor format
    inputs = _PROCESSOR(images=image, return_tensors="pt").to(_DEVICE)
    with torch.no_grad():
        generated = _MODEL.generate(**inputs, max_new_tokens=req.max_tokens)

    text = _PROCESSOR.batch_decode(generated, skip_special_tokens=True)[0]
    return PredictResponse(
        text=text,
        usage={"input_tokens": 0, "output_tokens": 0, "device": _DEVICE or "unknown"},
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8601)
    args = parser.parse_args()
    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
