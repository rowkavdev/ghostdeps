import httpx
import yaml


def load(url: str) -> object:
    return yaml.safe_load(httpx.get(url).text)
