import httpx


def fetch(url: str) -> bytes:
    return httpx.get(url, timeout=5).content
