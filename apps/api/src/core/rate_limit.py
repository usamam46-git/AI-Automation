import time
from typing import Callable

import redis.asyncio as aioredis
from fastapi import Depends, HTTPException, Request, status

from src.core.redis import get_redis


class RateLimiter:
    """
    FastAPI dependency for Redis-backed sliding window rate limiting.
    
    Usage:
        @router.post("/login", dependencies=[Depends(RateLimiter(requests=5, window=60))])
    """
    def __init__(self, requests: int, window: int):
        self.requests = requests
        self.window = window

    async def __call__(self, request: Request, redis: aioredis.Redis = Depends(get_redis)):
        # Identify the client by IP address. In production behind a proxy, 
        # ensure X-Forwarded-For or similar headers are respected.
        client_ip = request.client.host if request.client else "unknown"
        path = request.url.path
        
        # Redis key format: rate_limit:{path}:{ip}
        key = f"rate_limit:{path}:{client_ip}"
        
        # We use a simple sliding window using Redis ZSET (Sorted Set)
        now = time.time()
        window_start = now - self.window
        
        # Pipeline the commands for atomicity and performance
        async with redis.pipeline(transaction=True) as pipe:
            # Remove timestamps older than the window
            pipe.zremrangebyscore(key, 0, window_start)
            
            # Count the remaining items in the set (these are within the window)
            pipe.zcard(key)
            
            # Add the current request timestamp
            pipe.zadd(key, {str(now): now})
            
            # Set an expiry on the whole set so it cleans up naturally
            pipe.expire(key, self.window)
            
            # Execute pipeline
            results = await pipe.execute()
            
        request_count = results[1]  # result of zcard
        
        if request_count >= self.requests:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Too many requests. Please try again later.",
                headers={"Retry-After": str(self.window)}
            )
