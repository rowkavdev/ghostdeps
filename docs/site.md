# Documentation site maintenance

The site collects the Markdown already in `docs/`; `mkdocs.yml` is its navigation. It does not change the GitHub App or publish a site on its own. Build it locally with Python 3:

```sh
python3 -m venv .venv-docs
. .venv-docs/bin/activate
python -m pip install 'mkdocs==1.6.1'
python -m mkdocs build --strict
python -m mkdocs serve
```

The static output is in `site/` and can be hosted on GitHub Pages or another static host after a separate publishing decision. Keep the nav list current when docs are added or renamed. `--strict` turns broken links into build failures, so the existing docs tree stays connected. No public URL or publishing workflow is configured here.
