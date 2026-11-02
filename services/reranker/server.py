"""TEI-compatible scoring for Qwen's causal yes/no reranker (Apache-2.0 weights).

Scoring protocol: https://huggingface.co/Qwen/Qwen3-Reranker-0.6B
Inputs are never silently truncated. The 32K pair limit is independent of the
120K aggregate context assembled by RepoLead from multiple retrieved records.
"""
import os
import threading
from contextlib import asynccontextmanager

import torch
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from transformers import AutoModelForCausalLM, AutoTokenizer

MODEL = os.environ.get("MODEL_ID", "Qwen/Qwen3-Reranker-0.6B")
REVISION = os.environ.get("MODEL_REVISION", "e61197ed45024b0ed8a2d74b80b4d909f1255473")
MAX_INPUT = 32768
INSTRUCTION = "Given a question about a software repository, retrieve relevant code, documentation and evidence."
PREFIX = '<|im_start|>system\nJudge whether the Document meets the requirements based on the Query and the Instruct provided. Note that the answer can only be "yes" or "no".<|im_end|>\n<|im_start|>user\n'
SUFFIX = "<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n"
lock = threading.Lock()


@asynccontextmanager
async def lifespan(app):
    torch.set_num_threads(int(os.environ.get("TORCH_NUM_THREADS", "8")))
    app.state.tokenizer = AutoTokenizer.from_pretrained(MODEL, revision=REVISION, padding_side="left")
    app.state.model = AutoModelForCausalLM.from_pretrained(MODEL, revision=REVISION, dtype=torch.float32,
                                                         attn_implementation="sdpa").eval()
    yield


app = FastAPI(lifespan=lifespan)


class RerankRequest(BaseModel):
    query: str = Field(min_length=1, max_length=100000)
    texts: list[str] = Field(min_length=1, max_length=32)
    truncate: bool = False


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/info")
def info():
    return {"model_id": MODEL, "model_sha": REVISION, "model_dtype": "float32",
            "model_type": "causal-reranker", "max_input_length": MAX_INPUT,
            "max_client_batch_size": 32, "auto_truncate": False, "device": "cpu",
            "version": "repolead-qwen-reranker-v1"}


@app.post("/rerank")
def rerank(request: RerankRequest):
    if request.truncate:
        raise HTTPException(422, "Truncation is disabled; send complete inputs within the token limit.")
    if sum(len(text.encode("utf-8")) for text in request.texts) > 4 * 1024 * 1024:
        raise HTTPException(413, "Input batch size exceeds 4 MiB.")
    tokenizer = app.state.tokenizer
    records = [tokenizer.encode(f"{PREFIX}<Instruct>: {INSTRUCTION}\n<Query>: {request.query}\n<Document>: {text}{SUFFIX}",
                                add_special_tokens=False) for text in request.texts]
    if any(len(tokens) > MAX_INPUT for tokens in records):
        raise HTTPException(413, f"Input length exceeds {MAX_INPUT} tokens; no text was truncated.")
    yes, no = tokenizer.convert_tokens_to_ids(["yes", "no"])
    results = []
    # Serialize CPU inference; one pair at a time avoids padding long documents.
    with lock, torch.inference_mode():
        for index, tokens in enumerate(records):
            inputs = {"input_ids": torch.tensor([tokens]), "attention_mask": torch.ones((1, len(tokens)), dtype=torch.long)}
            logits = app.state.model(**inputs, use_cache=False, logits_to_keep=1).logits[0, -1]
            score = torch.softmax(logits[[no, yes]].float(), dim=0)[1].item()
            results.append({"index": index, "score": score})
    return sorted(results, key=lambda item: item["score"], reverse=True)
