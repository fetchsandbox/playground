"""Shared HTTP plumbing: one error type and one honest 429 retry."""

from __future__ import annotations

import time

import httpx


class ProviderError(Exception):
    """A provider refused or failed the call. `retryable` drives the next run."""

    def __init__(self, provider: str, message: str, status: int | None = None, retryable: bool = True):
        super().__init__(f"{provider}: {message}")
        self.provider = provider
        self.status = status
        self.retryable = retryable


def send(
    client: httpx.Client,
    provider: str,
    method: str,
    url: str,
    *,
    max_retry_after: float,
    **kwargs,
) -> httpx.Response:
    """Send a request, honouring one Retry-After on 429.

    A 429 means the provider did not perform the call, so a single retry after
    the advertised delay cannot double a side effect. Anything else is
    returned to the caller untouched.
    """
    try:
        r = client.request(method, url, **kwargs)
        if r.status_code == 429:
            delay = _retry_after(r)
            if delay is None or delay > max_retry_after:
                raise ProviderError(provider, f"rate limited (Retry-After={r.headers.get('Retry-After')})", 429)
            time.sleep(delay)
            r = client.request(method, url, **kwargs)
            if r.status_code == 429:
                raise ProviderError(provider, "rate limited twice", 429)
    except httpx.TimeoutException as exc:
        raise ProviderError(provider, f"timeout: {exc}") from exc
    except httpx.HTTPError as exc:
        raise ProviderError(provider, f"transport error: {exc}") from exc
    return r


def _retry_after(r: httpx.Response) -> float | None:
    raw = r.headers.get("Retry-After")
    if raw is None:
        return 1.0
    try:
        return max(0.0, float(raw))
    except ValueError:
        return None


def raise_for_google(provider: str, r: httpx.Response) -> None:
    if r.status_code < 300:
        return
    # 401/403 need a human (token revoked, scope missing); retrying won't help.
    retryable = r.status_code >= 500 or r.status_code == 429
    raise ProviderError(provider, f"HTTP {r.status_code}: {r.text[:300]}", r.status_code, retryable)
