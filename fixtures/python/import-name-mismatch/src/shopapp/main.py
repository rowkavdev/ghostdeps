import os.path
import tomllib
from PIL import Image
import yaml
from sklearn.linear_model import LinearRegression
import requests
import oddmod
import psycopg2
import cv2
import mystery_lib
from shopapp import helpers


def run(path: str) -> None:
    Image.open(path)
    yaml.safe_load("a: 1")
    LinearRegression()
    requests.get("https://example.com", timeout=5)
    oddmod.go()
    psycopg2.connect("")
    cv2.imread(path)
    mystery_lib.call()
    helpers.noop()
    print(os.path.basename(path), tomllib)
