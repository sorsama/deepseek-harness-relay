# Contributing

Issues and pull requests are welcome.

## Running it

```sh
pnpm install
pnpm typecheck && pnpm lint && pnpm test
pnpm build
```

To drive a real harness from a source checkout, mount this directory as an
overlay instead of installing it:

```sh
pnpm dsh web --patch /absolute/path/to/deepseek-harness-relay/cordis.patch.yml
```

## What the tests cover

`tests/fence.spec.ts` pins the vectors the trust fence must refuse — it is the
relay's whole defence against a rebound page, because proxying makes every
request look like loopback to the harness. `tests/auth.spec.ts` covers the
credential state machine. `tests/proxy.spec.ts` runs the listener against a
fake upstream and checks the header rewrite, WebSocket piping, and teardown.

A change to the fence, the credential classes, or the privileged-method list
needs a test in the same commit.

## Security

Please do not open a public issue for a vulnerability. See
[docs/SECURITY.md](docs/SECURITY.md).
