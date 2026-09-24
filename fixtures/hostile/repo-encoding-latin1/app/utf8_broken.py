import requests
# comment with invalid utf-8 bytes: €ÿ
requests.get("https://example.com")
