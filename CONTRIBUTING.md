# Contributing

## Docs website

This repo’s `docs/` is published as a MkDocs site and deployed to GitHub Pages automatically on every push to `main`.

- Expected URL: `https://kky42.github.io/unified-agent-sdk/`
- One-time setup: GitHub repo → Settings → Pages → Source → “GitHub Actions”

### Preview locally (optional)

```sh
python -m venv .venv
source .venv/bin/activate
pip install -r requirements-docs.txt
mkdocs serve
```
