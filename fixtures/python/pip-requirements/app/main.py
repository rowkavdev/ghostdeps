import click
import requests


@click.command()
@click.argument("url")
def main(url: str) -> None:
    print(requests.get(url, timeout=10).status_code)
