#!/usr/bin/env python3
"""
Docling Python subprocess service.

Communicates over stdin/stdout using JSON-line protocol.
Each line read from stdin is a JSON request; each line written to stdout is a
JSON response.

Supports concurrent parsing via thread pool executor.

Request format:
    {"id": "<string>", "file_path": "<string>", "options": {"ocr": false, "extract_tables": true}}

Response format:
    {"id": "<string>", "status": "ok"|"error", "data": {...}, "error": "<string>"}
"""

from __future__ import annotations

import asyncio
import json
import sys
import traceback
from concurrent.futures import ThreadPoolExecutor

from parser import parse_document_sync


# Maximum concurrent parsing tasks
MAX_CONCURRENT_PARSES = 5

# Thread pool for CPU-intensive document parsing
_executor = ThreadPoolExecutor(max_workers=MAX_CONCURRENT_PARSES)
_semaphore = asyncio.Semaphore(MAX_CONCURRENT_PARSES)


async def handle_request(raw: str) -> str:
    """Parse a single JSON-line request, dispatch to parser, return JSON-line response."""
    try:
        request = json.loads(raw)
    except json.JSONDecodeError as exc:
        return json.dumps({"id": None, "status": "error", "error": f"Invalid JSON: {exc}"})

    request_id = request.get("id")
    file_path = request.get("file_path")
    options = request.get("options", {})

    if not file_path:
        return json.dumps({"id": request_id, "status": "error", "error": "Missing file_path"})

    try:
        async with _semaphore:
            loop = asyncio.get_event_loop()
            data = await loop.run_in_executor(
                _executor, parse_document_sync, file_path, options
            )
        return json.dumps({"id": request_id, "status": "ok", "data": data}, ensure_ascii=True)
    except Exception as exc:
        tb = traceback.format_exc()
        return json.dumps({"id": request_id, "status": "error", "error": f"{exc}\n{tb}"})


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
            # EOF – parent process closed stdin
            break

        decoded = line.decode("utf-8").strip()
        if not decoded:
            continue

        response = await handle_request(decoded)
        writer.write((response + "\n").encode("utf-8"))
        await writer.drain()

    writer.close()


def main() -> None:
    asyncio.run(read_stdin_loop())


if __name__ == "__main__":
    main()
