#!/usr/bin/env python3
"""Qwen3-ASR on this Mac (MLX), for the speech benchmark: the on-device model OpenOats
uses. Loads the model once, then reads one JSON request per line on stdin
({"file": path, "language": "English"|"Hindi"|null}) and answers one JSON line each.
Run from qualification/speech/.venv (pip install mlx-qwen3-asr). Model: QWEN_ASR_MODEL,
default Qwen/Qwen3-ASR-0.6B (downloaded from Hugging Face on first use)."""
import json, os, sys, time
from mlx_qwen3_asr import Session

session = Session(os.environ.get("QWEN_ASR_MODEL", "Qwen/Qwen3-ASR-0.6B"))
print(json.dumps({"ready": True}), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    started = time.perf_counter()
    try:
        result = session.transcribe(request["file"], language=request.get("language"))
        print(json.dumps({"text": result.text, "ms": (time.perf_counter() - started) * 1000}), flush=True)
    except Exception as error:  # reported per clip; the benchmark records it and goes on
        print(json.dumps({"error": str(error)[:300]}), flush=True)
