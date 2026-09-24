import httpx


def fetch(url: str) -> int:
    return httpx.get(url).status_code
