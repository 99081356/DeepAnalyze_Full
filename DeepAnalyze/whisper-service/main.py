#!/usr/bin/env python3
"""
Whisper ASR service.

Supports two modes:
1. Subprocess mode (default): communicates over stdin/stdout using JSON-line protocol.
2. HTTP mode (--http): provides OpenAI-compatible /v1/audio/transcriptions endpoint.

Subprocess request format:
    {"id": "<string>", "file_path": "<string>", "language": "zh"|null, "model_size": "base"}

Subprocess response format:
    {"id": "<string>", "status": "ok"|"error", "data": {"text": "...", "language": "..."}, "error": "<string>"}

HTTP mode endpoints:
    GET  /health                     — health check
    POST /v1/audio/transcriptions    — OpenAI-compatible transcription API
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import tempfile
import traceback
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, Optional

# ---------------------------------------------------------------------------
# Lazy-loaded Whisper model cache
# ---------------------------------------------------------------------------

_whisper_module: Any = None
_model_cache: Dict[str, Any] = {}


def _get_whisper():
    """Lazily import the whisper module."""
    global _whisper_module
    if _whisper_module is None:
        import whisper
        _whisper_module = whisper
    return _whisper_module


def _get_model(model_size: str):
    """Load (or retrieve from cache) a Whisper model of the given size."""
    if model_size not in _model_cache:
        whisper = _get_whisper()
        _model_cache[model_size] = whisper.load_model(model_size, device="cpu")
    return _model_cache[model_size]


def transcribe_sync(
    file_path: str,
    language: Optional[str] = None,
    model_size: str = "base",
) -> Dict[str, Any]:
    """Run Whisper transcription synchronously (called from thread pool)."""
    model = _get_model(model_size)

    transcribe_kwargs: Dict[str, Any] = {}
    if language:
        transcribe_kwargs["language"] = language

    # Use Simplified Chinese prompt to guide output style.
    # Whisper's initial_prompt influences the tokenizer's output preference.
    # Without this, Whisper base model tends to output Traditional Chinese
    # even for Simplified Chinese input audio.
    if language == "zh" or language is None:
        transcribe_kwargs["initial_prompt"] = "以下是普通话的句子。"

    result = model.transcribe(file_path, **transcribe_kwargs)

    return {
        "text": result.get("text", ""),
        "language": result.get("language", None),
    }


# ---------------------------------------------------------------------------
# Concurrency control
# ---------------------------------------------------------------------------

MAX_CONCURRENT_TRANSCRIPTIONS = 2

_executor = ThreadPoolExecutor(max_workers=MAX_CONCURRENT_TRANSCRIPTIONS)
_semaphore = asyncio.Semaphore(MAX_CONCURRENT_TRANSCRIPTIONS)


# ---------------------------------------------------------------------------
# Subprocess mode: Request handler
# ---------------------------------------------------------------------------

async def handle_request(raw: str) -> str:
    """Parse a single JSON-line request, dispatch to Whisper, return JSON-line response."""
    try:
        request = json.loads(raw)
    except json.JSONDecodeError as exc:
        return json.dumps({"id": None, "status": "error", "error": f"Invalid JSON: {exc}"})

    request_id = request.get("id")
    file_path = request.get("file_path")
    language = request.get("language") or None
    model_size = request.get("model_size", "base")

    if not file_path:
        return json.dumps({"id": request_id, "status": "error", "error": "Missing file_path"})

    # Validate model_size
    valid_sizes = {"tiny", "base", "small", "medium", "large"}
    if model_size not in valid_sizes:
        return json.dumps({
            "id": request_id,
            "status": "error",
            "error": f"Invalid model_size '{model_size}'. Must be one of: {', '.join(sorted(valid_sizes))}",
        })

    try:
        async with _semaphore:
            loop = asyncio.get_event_loop()
            data = await loop.run_in_executor(
                _executor, transcribe_sync, file_path, language, model_size
            )
        return json.dumps({"id": request_id, "status": "ok", "data": data}, ensure_ascii=True)
    except Exception as exc:
        tb = traceback.format_exc()
        return json.dumps({"id": request_id, "status": "error", "error": f"{exc}\n{tb}"})


# ---------------------------------------------------------------------------
# Subprocess mode: Main event loop
# ---------------------------------------------------------------------------

async def read_stdin_loop() -> None:
    """Main event loop: read lines from stdin, process, write to stdout."""
    loop = asyncio.get_event_loop()
    reader = asyncio.StreamReader()

    protocol = asyncio.StreamReaderProtocol(reader)
    await loop.connect_read_pipe(lambda: protocol, sys.stdin)

    writer_transport, writer_protocol = await loop.connect_write_pipe(
        asyncio.streams.FlowControlMixin, sys.stdout
    )
    writer = asyncio.StreamWriter(writer_transport, writer_protocol, reader, loop)

    while True:
        line: bytes = await reader.readline()
        if not line:
            # EOF - parent process closed stdin
            break

        decoded = line.decode("utf-8").strip()
        if not decoded:
            continue

        response = await handle_request(decoded)
        writer.write((response + "\n").encode("utf-8"))
        await writer.drain()

    writer.close()


# ---------------------------------------------------------------------------
# HTTP mode: lightweight HTTP server (stdlib only, no FastAPI dependency)
# ---------------------------------------------------------------------------

async def handle_http_transcribe(file_path: str, language: Optional[str] = None, model_size: str = "base") -> Dict[str, Any]:
    """Run transcription for HTTP mode."""
    async with _semaphore:
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(
            _executor, transcribe_sync, file_path, language, model_size
        )


async def http_handler(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    """Handle a single HTTP connection."""
    try:
        # Read request line
        request_line = await reader.readline()
        if not request_line:
            writer.close()
            return

        request_str = request_line.decode("utf-8", errors="replace").strip()
        parts = request_str.split(" ")
        if len(parts) < 2:
            writer.close()
            return
        method = parts[0].upper()
        path = parts[1]

        # Read headers
        headers: Dict[str, str] = {}
        content_length = 0
        while True:
            header_line = await reader.readline()
            if not header_line or header_line == b"\r\n" or header_line == b"\n":
                break
            header_str = header_line.decode("utf-8", errors="replace").strip()
            if ":" in header_str:
                key, _, val = header_str.partition(":")
                headers[key.strip().lower()] = val.strip()
                if key.strip().lower() == "content-length":
                    try:
                        content_length = int(val.strip())
                    except ValueError:
                        pass

        # Read body if present
        body = b""
        if content_length > 0:
            body = await reader.readexactly(content_length)

        # Route
        if path == "/health" and method == "GET":
            response = json.dumps({"status": "ok", "model_loaded": len(_model_cache) > 0})
            _send_json(writer, 200, response)

        elif path == "/v1/audio/transcriptions" and method == "POST":
            await _handle_transcription(writer, headers, body)
        else:
            _send_json(writer, 404, json.dumps({"error": "Not found"}))

    except Exception as exc:
        try:
            _send_json(writer, 500, json.dumps({"error": str(exc)}))
        except Exception:
            pass
    finally:
        try:
            writer.close()
        except Exception:
            pass


async def _handle_transcription(
    writer: asyncio.StreamWriter,
    headers: Dict[str, str],
    body: bytes,
) -> None:
    """Handle POST /v1/audio/transcriptions — multipart form data."""
    content_type = headers.get("content-type", "")

    # Parse multipart form data
    boundary = None
    if "boundary=" in content_type:
        boundary = content_type.split("boundary=")[-1].strip()
        # Handle quoted boundary
        if boundary.startswith('"') and boundary.endswith('"'):
            boundary = boundary[1:-1]

    if not boundary:
        _send_json(writer, 400, json.dumps({"error": "Missing multipart boundary"}))
        return

    boundary_bytes = boundary.encode("utf-8")
    parts_list = body.split(b"--" + boundary_bytes)

    file_data: Optional[bytes] = None
    file_name = "audio.wav"
    language: Optional[str] = None
    model_size = "base"

    for part in parts_list:
        if not part or part == b"--\r\n" or part == b"--":
            continue

        # Split headers from body
        header_end = part.find(b"\r\n\r\n")
        if header_end < 0:
            continue

        part_headers = part[:header_end].decode("utf-8", errors="replace").lower()
        part_body = part[header_end + 4:]
        # Strip trailing \r\n
        if part_body.endswith(b"\r\n"):
            part_body = part_body[:-2]

        if 'name="file"' in part_headers:
            file_data = part_body
            # Extract filename
            fn_match = __import__("re").search(r'filename="([^"]+)"', part_headers)
            if fn_match:
                file_name = fn_match.group(1)
        elif 'name="language"' in part_headers:
            lang_text = part_body.decode("utf-8", errors="replace").strip()
            if lang_text:
                language = lang_text
        elif 'name="model"' in part_headers:
            model_text = part_body.decode("utf-8", errors="replace").strip()
            if model_text in ("tiny", "base", "small", "medium", "large"):
                model_size = model_text

    if not file_data:
        _send_json(writer, 400, json.dumps({"error": "No audio file provided"}))
        return

    # Write to temp file
    with tempfile.NamedTemporaryFile(suffix=f"_{file_name}", delete=False) as tmp:
        tmp.write(file_data)
        tmp_path = tmp.name

    try:
        result = await handle_http_transcribe(tmp_path, language, model_size)
        response = {
            "text": result.get("text", ""),
            "language": result.get("language"),
        }
        _send_json(writer, 200, json.dumps(response, ensure_ascii=True))
    except Exception as exc:
        _send_json(writer, 500, json.dumps({"error": str(exc)}))
    finally:
        os.unlink(tmp_path)


def _send_json(writer: asyncio.StreamWriter, status: int, body: str) -> None:
    """Send a JSON HTTP response."""
    status_text = {200: "OK", 400: "Bad Request", 404: "Not Found", 500: "Internal Server Error"}.get(status, "OK")
    response = (
        f"HTTP/1.1 {status} {status_text}\r\n"
        f"Content-Type: application/json\r\n"
        f"Content-Length: {len(body.encode('utf-8'))}\r\n"
        f"Connection: close\r\n"
        f"\r\n"
        f"{body}"
    )
    writer.write(response.encode("utf-8"))


async def run_http_server(host: str, port: int) -> None:
    """Start the HTTP server."""
    server = await asyncio.start_server(http_handler, host, port)
    print(f"[Whisper HTTP] Listening on {host}:{port}", flush=True)
    async with server:
        await server.serve_forever()


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Whisper ASR service")
    parser.add_argument("--http", action="store_true", help="Run in HTTP server mode")
    parser.add_argument("--host", default="127.0.0.1", help="HTTP host (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=9877, help="HTTP port (default: 9877)")
    args = parser.parse_args()

    if args.http:
        asyncio.run(run_http_server(args.host, args.port))
    else:
        asyncio.run(read_stdin_loop())


if __name__ == "__main__":
    main()
