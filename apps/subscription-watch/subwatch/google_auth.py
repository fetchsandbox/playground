"""Google OAuth: static token for tests, refresh-token exchange for production."""

from __future__ import annotations

import httpx

from .config import Settings
from .http import ProviderError

TOKEN_URL = "https://oauth2.googleapis.com/token"


def google_access_token(settings: Settings, client: httpx.Client | None = None) -> str:
    if settings.google_access_token:
        return settings.google_access_token
    if not (settings.google_client_id and settings.google_client_secret and settings.google_refresh_token):
        raise ProviderError("google", "no GOOGLE_ACCESS_TOKEN and no refresh-token credentials configured", retryable=False)
    own = client is None
    client = client or httpx.Client(timeout=settings.http_timeout)
    try:
        r = client.post(
            TOKEN_URL,
            data={
                "client_id": settings.google_client_id,
                "client_secret": settings.google_client_secret,
                "refresh_token": settings.google_refresh_token,
                "grant_type": "refresh_token",
            },
        )
    finally:
        if own:
            client.close()
    if r.status_code != 200:
        raise ProviderError("google", f"token refresh failed: HTTP {r.status_code} {r.text[:200]}", r.status_code, retryable=r.status_code >= 500)
    return r.json()["access_token"]
