# Contributing

## Docs site

This repo’s `docs/` is published via MkDocs and deployed to GitHub Pages on every push to `main`.

### Preview locally (optional)

```sh
python -m venv .venv
source .venv/bin/activate
pip install -r requirements-docs.txt
mkdocs serve
```

## Development commands

```sh
npm run typecheck
npm run build
npm test
```

For test strategy and real-execution suites, see **Specs → Testing**.
