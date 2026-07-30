"""Bounded, ordered dispatch for offline machine translation."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable

logger = logging.getLogger(__name__)

TranslationWorker = Callable[[dict], Awaitable[None]]
ErrorCallback = Callable[[Exception, dict], None]


class TranslationDispatcher:
    """Run one translation at a time without blocking the caption receive loop.

    The queue retains the newest segments under pressure. Enqueueing is always
    synchronous; when capacity is exhausted, the oldest queued (not active)
    segment is discarded and the caller is told how many items were dropped.
    """

    def __init__(
        self,
        worker: TranslationWorker,
        *,
        capacity: int,
        on_error: ErrorCallback | None = None,
    ) -> None:
        if capacity < 1:
            raise ValueError("capacity must be at least 1")
        self._worker = worker
        self._on_error = on_error
        self._queue: asyncio.Queue[dict] = asyncio.Queue(maxsize=capacity)
        self._runner: asyncio.Task[None] | None = None
        self._closed = False

    def start(self) -> None:
        """Start exactly one runner task."""
        if self._closed or self._runner is not None:
            return
        self._runner = asyncio.create_task(self._run())

    def enqueue(self, segment: dict) -> int:
        """Queue a segment immediately, dropping the oldest queued item if full."""
        if self._closed:
            return 0

        dropped = 0
        if self._queue.full():
            self._queue.get_nowait()
            self._queue.task_done()
            dropped = 1
        self._queue.put_nowait(segment)
        return dropped

    async def close(self, *, drain: bool) -> None:
        """Stop dispatch and await the runner so no translation task is orphaned."""
        if self._closed:
            if self._runner is not None:
                await self._await_runner()
            return

        if drain and self._runner is None and not self._queue.empty():
            self.start()
        self._closed = True

        if drain:
            await self._queue.join()
        else:
            while not self._queue.empty():
                self._queue.get_nowait()
                self._queue.task_done()

        if self._runner is not None:
            self._runner.cancel()
            await self._await_runner()

    async def _await_runner(self) -> None:
        assert self._runner is not None
        try:
            await self._runner
        except asyncio.CancelledError:
            pass

    async def _run(self) -> None:
        while True:
            segment = await self._queue.get()
            try:
                await self._worker(segment)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                if self._on_error is None:
                    logger.exception(
                        "Translation worker failed for segment %s",
                        segment.get("segment_id"),
                    )
                else:
                    try:
                        self._on_error(exc, segment)
                    except Exception:
                        logger.exception("Translation dispatcher error callback failed")
            finally:
                self._queue.task_done()
