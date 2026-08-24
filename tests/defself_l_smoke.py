#!/usr/bin/env python3
"""Smoke checks for the experimental defself_l prototype."""

from datetime import datetime
import os
import sys


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(ROOT, "src", "services"))

from defself_l import LearningRecord, MemoryStore, SelfLearningAgent  # noqa: E402


def make_record(text: str) -> LearningRecord:
    return LearningRecord(
        timestamp=datetime.now(),
        input=text,
        intent="request_information",
        plan={"steps": ["retrieve"]},
        response="ok",
    )


def main() -> None:
    store = MemoryStore()
    store.save(make_record("python coding help"))
    store.save(make_record("gardening tips"))

    # Should not raise TypeError: unhashable type: 'LearningRecord'
    records = store.retrieve("python help", top_k=2)
    assert len(records) >= 1, "Expected at least one relevant record"

    response, metadata = SelfLearningAgent().process("How do I write a Python function?")
    assert isinstance(response, str) and len(response) > 0
    assert isinstance(metadata, dict) and "type" in metadata

    print("defself_l smoke checks passed")


if __name__ == "__main__":
    main()
