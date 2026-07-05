#!/bin/bash
set -e

# MinerU ships a CLI (magic-pdf) and a Python API. We expose a tiny FastAPI
# wrapper providing /health, /file_parse, and /tasks endpoints compatible
# with src/services/document-processors/mineru-client.ts.

cat > /app/server.py <<'PYEOF'
import os
import tempfile
from pathlib import Path
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI(title="DeepAnalyze MinerU Service")


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/file_parse")
async def file_parse(
    file: UploadFile = File(...),
    parse_method: str = Form("auto"),
):
    try:
        from magic_pdf.pipe.UNIPipe import UNIPipe
        from magic_pdf.rw.DiskReaderWriter import DiskReaderWriter
        import magic_pdf.model as model_config
        model_config.__use_inside_model = True
        model_config.__model_mode = "auto"

        with tempfile.TemporaryDirectory() as tmpdir:
            pdf_path = Path(tmpdir) / file.filename
            pdf_path.write_bytes(await file.read())
            image_dir = Path(tmpdir) / "images"
            image_dir.mkdir()

            disk_reader = DiskReaderWriter(tmpdir)
            pipe = UNIPipe(pdf_path.read_bytes(), disk_reader, image_dir)
            pipe.apply()

            md_content = pipe.pipe_mk_uni_format(image_dir, drop_mode="none")
            return JSONResponse({
                "md_content": md_content,
                "images": [],
                "parse_method": parse_method,
            })
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/tasks")
async def create_task(file: UploadFile = File(...)):
    # Synchronous for simplicity; could be made async with task ID later.
    return await file_parse(file)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8001")))
PYEOF

# Add fastapi/uvicorn if not bundled with magic-pdf
pip3 install --no-cache-dir fastapi uvicorn[standard] python-multipart || true

exec python3 /app/server.py
