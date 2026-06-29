# Contributing

Thanks for your interest! This repository holds the open-source **client libraries** for Kaval — thin
HTTP clients for the hosted API. (The Kaval engine and platform are closed-source and live elsewhere.)

## Development

```bash
pnpm install
pnpm check        # build + lint + typecheck + test (the Node SDK + MCP server)
```

For the Python SDK:

```bash
cd sdks/python
pip install -e ".[dev]"
pytest
```

## Pull requests

- Keep PRs focused; describe the change and how you verified it.
- Add or update tests for behavior changes. Most tests are hermetic (a fake/injected `fetch` — no
  network, no API key).
- Match the surrounding code style — Prettier-formatted; `pnpm lint` must pass.

## Security

Do **not** open public issues for security vulnerabilities — see [SECURITY.md](SECURITY.md).
