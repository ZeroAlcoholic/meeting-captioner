"""Tests for bounded, ordered offline translation dispatch."""

from __future__ import annotations

import asyncio

import pytest

from app.pipeline.translation_dispatcher import TranslationDispatcher


def _segment(segment_id: str) -> dict:
    return {"segment_id": segment_id}


@pytest.mark.asyncio
async def test_full_queue_drops_oldest_and_keeps_newest() -> None:
    gate = asyncio.Event()
    seen: list[str] = []

    async def worker(seg: dict) -> None:
        await gate.wait()
        seen.append(seg["segment_id"])

    dispatcher = TranslationDispatcher(worker, capacity=2)
    assert dispatcher.enqueue(_segment("a")) == 0
    assert dispatcher.enqueue(_segment("b")) == 0
    assert dispatcher.enqueue(_segment("c")) == 1
    dispatcher.start()
    gate.set()
    await dispatcher.close(drain=True)

    assert seen == ["b", "c"]


@pytest.mark.asyncio
async def test_worker_processes_segments_in_fifo_order() -> None:
    seen: list[str] = []

    async def worker(seg: dict) -> None:
        seen.append(seg["segment_id"])

    dispatcher = TranslationDispatcher(worker, capacity=3)
    dispatcher.enqueue(_segment("a"))
    dispatcher.enqueue(_segment("b"))
    dispatcher.enqueue(_segment("c"))
    dispatcher.start()
    await dispatcher.close(drain=True)

    assert seen == ["a", "b", "c"]


@pytest.mark.asyncio
async def test_enqueue_returns_immediately_while_worker_is_blocked() -> None:
    gate = asyncio.Event()
    started = asyncio.Event()

    async def worker(seg: dict) -> None:
        started.set()
        await gate.wait()

    dispatcher = TranslationDispatcher(worker, capacity=2)
    dispatcher.start()
    dispatcher.enqueue(_segment("a"))
    await asyncio.wait_for(started.wait(), timeout=1)

    assert dispatcher.enqueue(_segment("b")) == 0
    assert dispatcher.enqueue(_segment("c")) == 0
    assert dispatcher.enqueue(_segment("d")) == 1

    gate.set()
    await dispatcher.close(drain=True)


@pytest.mark.asyncio
async def test_worker_exception_is_reported_and_next_segment_runs() -> None:
    seen: list[str] = []
    errors: list[tuple[Exception, str]] = []

    async def worker(seg: dict) -> None:
        if seg["segment_id"] == "bad":
            raise RuntimeError("translation failed")
        seen.append(seg["segment_id"])

    def on_error(exc: Exception, seg: dict) -> None:
        errors.append((exc, seg["segment_id"]))

    dispatcher = TranslationDispatcher(worker, capacity=2, on_error=on_error)
    dispatcher.enqueue(_segment("bad"))
    dispatcher.enqueue(_segment("good"))
    dispatcher.start()
    await dispatcher.close(drain=True)

    assert len(errors) == 1
    assert isinstance(errors[0][0], RuntimeError)
    assert errors[0][1] == "bad"
    assert seen == ["good"]


@pytest.mark.asyncio
async def test_close_without_drain_cancels_worker_and_discards_queued_work() -> None:
    started = asyncio.Event()
    cancelled = asyncio.Event()
    completed: list[str] = []

    async def worker(seg: dict) -> None:
        started.set()
        try:
            await asyncio.Future()
        except asyncio.CancelledError:
            cancelled.set()
            raise
        completed.append(seg["segment_id"])

    dispatcher = TranslationDispatcher(worker, capacity=2)
    dispatcher.start()
    dispatcher.enqueue(_segment("active"))
    dispatcher.enqueue(_segment("queued"))
    await asyncio.wait_for(started.wait(), timeout=1)

    await dispatcher.close(drain=False)

    assert cancelled.is_set()
    assert completed == []
    assert dispatcher.enqueue(_segment("late")) == 0
