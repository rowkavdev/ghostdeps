import requests


def status() -> int:
    return requests.get("http://localhost/health").status_code
