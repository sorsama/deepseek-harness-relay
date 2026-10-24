# Contributing

Issues and pull requests are welcome.

## Building and testing

```sh
pnpm install
pnpm typecheck && pnpm lint && pnpm test
pnpm build
```

## Running your checkout against a real harness

The quickest way is to load this folder as an overlay instead of installing it:

```sh
pnpm dsh web --patch /absolute/path/to/deepseek-harness-relay/cordis.patch.yml
```

To point a harness you already run at the built files, write a small overlay of your own:

```yaml
# dev.cordis.yml
- insert:
    - id: relay
      name: 'file:///D:/path/to/deepseek-harness-relay/lib/index.js'
      config:
        stateDir: 'D:/path/to/scratch/relay-state'
        tls: 'off'
```

```sh
dsh web --patch ./dev.cordis.yml
```

On Windows, the plugin path has to be a `file://` URL. A bare `D:/...` path fails with `ERR_UNSUPPORTED_ESM_URL_SCHEME`, because Node's ESM resolver reads `d:` as a protocol.

## Installing your checkout into a harness

You can install a cloned folder directly:

```sh
dsh plugin --profile web add ./deepseek-harness-relay
```

On Windows this fails silently when the checkout is on a different drive from `~/.dsh`. pnpm records the absolute path as a `link:` dependency, then resolves it relative to the profile folder, which produces a broken link such as `C:\Users\you\.dsh\profiles\web\D:\LabTeto\...`. The harness then warns:

```
dsh: warning: dsh-relay declares no dsh.bundle — installed as a plain dependency, not a profile layer
```

A tarball avoids this, because pnpm copies it instead of linking it:

```sh
cd deepseek-harness-relay
pnpm build && pnpm pack
dsh plugin --profile web add ./dsh-relay-<version>.tgz
```

## What the tests cover

- `tests/fence.spec.ts` lists the requests the trust fence must refuse. The fence is the relay's whole defence against DNS rebinding, because proxying makes every request look like loopback to the harness.
- `tests/auth.spec.ts` covers the credential state machine.
- `tests/proxy.spec.ts` runs the listener against a fake upstream and checks the header rewrite, WebSocket piping, and shutdown.

Any change to the fence, the credential classes, or the privileged-method list needs a test in the same commit.

## Two settings-page traps

The settings page on harness 0.1.7 and later fails silently in two ways. If the relay works but has no Configure page, check these first:

- The settings namespace is the loader entry id (`relay`). If the plugin's schema isn't on the default export, it gets no namespace at all, and nothing is logged.
- Form fields need `.volatile()`. A schema without any volatile fields produces no settings page, not an empty one. See the comment on `Config` in `src/config.ts`.

## Releasing

1. Bump `version` in `package.json`, add a `CHANGELOG.md` entry, and merge.
2. Tag the merge commit (`git tag -a vX.Y.Z -m "Release X.Y.Z: …"`) and push the tag.
3. Publish a GitHub release for the tag. `.github/workflows/publish.yml` then checks, builds, and publishes to npm through trusted publishing, so no npm token or login is needed. A prerelease version goes to the `next` tag.

## Security

Please don't open a public issue for a vulnerability. See [docs/SECURITY.md](docs/SECURITY.md).
