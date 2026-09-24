"""JSON codec: orjson when the "fast" extra is installed, stdlib json otherwise."""

try:
    import orjson

    def dumps(obj: object) -> bytes:
        return orjson.dumps(obj)

except ImportError:  # pragma: no cover - extra not installed
    import json

    def dumps(obj: object) -> bytes:
        return json.dumps(obj).encode()


def load_config(path: str) -> dict:
    # Lazy import: only callers using YAML configs need the "yaml" extra.
    import yaml

    with open(path) as handle:
        return yaml.safe_load(handle)
