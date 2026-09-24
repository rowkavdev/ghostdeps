# Webhook payload fixtures

Trimmed webhook payloads in the shape GitHub delivers (see https://docs.github.com/en/webhooks/webhook-events-and-payloads). IDs, SHAs and names are synthetic. Tests sign them with a test-only secret and post them through the real Probot middleware, so signature verification runs on every test delivery.
