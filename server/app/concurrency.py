import asyncio
from typing import Awaitable, Callable, Sequence, TypeVar

T = TypeVar("T")


async def map_with_concurrency(items: Sequence[T], limit: int, fn: Callable[[T, int], Awaitable[None]]) -> None:
    """Runs `fn` over `items` with at most `limit` in flight at once.

    Used anywhere we'd otherwise fire one GitHub/Claude call per item sequentially
    (slow) or all at once (rate-limit/resource risk).
    """
    next_index = 0
    lock = asyncio.Lock()

    async def worker() -> None:
        nonlocal next_index
        while True:
            async with lock:
                if next_index >= len(items):
                    return
                i = next_index
                next_index += 1
            await fn(items[i], i)

    worker_count = min(limit, len(items))
    await asyncio.gather(*(worker() for _ in range(worker_count)))
