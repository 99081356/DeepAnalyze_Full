#!/usr/bin/env python3
"""
Lightweight OpenAI-compatible embedding server using BGE-M3.
Loads model from data/models/bge-m3/ and serves /v1/embeddings endpoint.
Started automatically by start.py alongside the backend.
"""

import json
import sys
import os
import time
import uuid
import argparse
from http.server import HTTPServer, BaseHTTPRequestHandler

# Suppress tokenizer warnings
os.environ["TOKENIZERS_PARALLELISM"] = "false"

MODEL = None
MODEL_PATH = None
MODEL_DIMENSION = 1024


class EmbeddingHandler(BaseHTTPRequestHandler):
    """OpenAI-compatible /v1/embeddings handler."""

    def log_message(self, format, *args):
        # Suppress default HTTP logging
        pass

    def _send_json(self, code, data):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._send_json(200, {"status": "ok", "model": "bge-m3", "dimension": MODEL_DIMENSION})
        elif self.path == "/v1/models":
            self._send_json(200, {
                "object": "list",
                "data": [{"id": "bge-m3", "object": "model", "owned_by": "local"}]
            })
        else:
            self._send_json(404, {"error": "Not found"})

    def do_POST(self):
        if self.path != "/v1/embeddings":
            self._send_json(404, {"error": "Not found"})
            return

        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length).decode("utf-8")

        try:
            req = json.loads(body)
        except json.JSONDecodeError:
            self._send_json(400, {"error": "Invalid JSON"})
            return

        input_texts = req.get("input", "")
        if isinstance(input_texts, str):
            input_texts = [input_texts]

        if not input_texts:
            self._send_json(400, {"error": "Empty input"})
            return

        try:
            embeddings = MODEL.encode(
                input_texts,
                normalize_embeddings=True,
                show_progress_bar=False,
            )
        except Exception as e:
            self._send_json(500, {"error": f"Encoding failed: {e}"})
            return

        data = []
        for i, emb in enumerate(embeddings):
            data.append({
                "object": "embedding",
                "index": i,
                "embedding": emb.tolist(),
            })

        usage = {
            "prompt_tokens": sum(len(t.split()) for t in input_texts),
            "total_tokens": sum(len(t.split()) for t in input_texts),
        }

        self._send_json(200, {
            "object": "list",
            "data": data,
            "model": req.get("model", "bge-m3"),
            "usage": usage,
        })


def main():
    parser = argparse.ArgumentParser(description="BGE-M3 Embedding Server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=11435)
    parser.add_argument("--model-path", default=None)
    args = parser.parse_args()

    global MODEL, MODEL_PATH

    # Resolve model path
    if args.model_path:
        MODEL_PATH = args.model_path
    else:
        # Default: look relative to this script
        script_dir = os.path.dirname(os.path.abspath(__file__))
        MODEL_PATH = os.path.join(script_dir, "data", "models", "bge-m3")

    if not os.path.isdir(MODEL_PATH):
        print(f"[EmbeddingServer] Model not found at {MODEL_PATH}", file=sys.stderr)
        sys.exit(1)

    print(f"[EmbeddingServer] Loading BGE-M3 from {MODEL_PATH}...")
    start = time.time()

    from sentence_transformers import SentenceTransformer
    MODEL = SentenceTransformer(MODEL_PATH)

    elapsed = time.time() - start
    print(f"[EmbeddingServer] BGE-M3 loaded in {elapsed:.1f}s (dim={MODEL_DIMENSION})")

    server = HTTPServer((args.host, args.port), EmbeddingHandler)
    print(f"[EmbeddingServer] Listening on http://{args.host}:{args.port}")
    print(f"[EmbeddingServer] Endpoints: /v1/embeddings, /v1/models, /health")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[EmbeddingServer] Shutting down...")
        server.server_close()


if __name__ == "__main__":
    main()
