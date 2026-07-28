# Contributing

Thanks for your interest! This repository holds the open-source **client libraries** for Kaval — thin
HTTP clients for the hosted API. (The Kaval engine and platform are closed-source and live elsewhere.)

## Development

```bash
pnpm install
pnpm check        # build + lint + typecheck + test (the Node SDK + MCP server)
pnpm check:docs   # README + CHANGELOG against the shipped surface and the CI gate
```

For the Python SDK:

```bash
cd sdks/python
pip install -e ".[dev]"
pytest
```

The Python SDK supports 3.10 and up, and CI tests both ends of that range — if a change needs a
newer interpreter, raise `requires-python` in `pyproject.toml` rather than assuming 3.13.

## Pull requests

- Keep PRs focused; describe the change and how you verified it.
- Add or update tests for behavior changes. Most tests are hermetic (a fake/injected `fetch` — no
  network, no API key). A hermetic test proves the client sends what you meant; it cannot prove the
  server accepts it. If a change touches the wire contract, extend the live suites too
  (`packages/mcp/test/live-tools.test.ts`, `sdks/python/tests/test_live.py`) — the nightly **Live
  API** CI job runs them against a real server, and releases are gated on it.
- Match the surrounding code style — Prettier-formatted; `pnpm lint` must pass.

## Security

Do **not** open public issues for security vulnerabilities — see [SECURITY.md](SECURITY.md).
