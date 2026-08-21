# Changelog

## 0.1.1 — 2026-08-21

No code changes. 0.1.0 was published before the documentation switched to the
registry install, so its package page told readers to install from GitHub and
warned about a build script that a registry install never runs.


## 0.1.0 — 2026-08-21

Published to npm as `dsh-relay`, prebuilt, so `dsh plugin add dsh-relay` needs no
build permission on the installing machine.

First release.

- A second listener in front of an untouched loopback harness: TLS termination,
  authentication, and a transparent reverse proxy for `/api`, both WebSocket
  downlinks, the client plugin bundles, and the web application itself.
- The relay carries its own DNS-rebinding and cross-site fence, applied before
  the `Host` rewrite that the harness's own fence would otherwise catch.
- Password sign-in (scrypt, signed `HttpOnly; SameSite=Strict` cookie), QR and
  passcode device pairing with revocable bearer tokens, a device list, and a
  key-rotating "sign out everywhere".
- Self-signed certificates with a published SPKI pin, or bring your own.
- `_dsh._tcp` mDNS advertisement.
- An opt-out compatibility path for DSH Mobile 0.5.0, which cannot present a
  credential: a plain-HTTP listener and short-lived private-address grants that
  never reach the harness configuration plane.
- Refuses to start when the harness web server is already bound to `0.0.0.0`.
- A **Relay** card on the harness's Plugin configuration tab, over a `relay`
  settings namespace, carrying the configuration switches; changing one
  rebinds the listeners. It renders only on the machine running the harness,
  because the harness serves settings namespaces to a loopback browser only —
  so pairing, devices, the certificate pin, and the password stay on the
  relay's own pages, reachable from any device through a **Relay** link
  injected with `ctx.webServer.tapIndex`.
- A client bundle that fails to build no longer bricks the harness: a
  `dsh.client` package whose `lib/client.js` is missing makes
  `ClientModuleRegistry` throw and `dsh web` then serves no web UI at all, so
  `prepare` withdraws the declaration instead of shipping that state.
- Configuration lives entirely in the bundle patch and the profile's own layer.
  There is no `--relay-*` command line: the surface app owns the invocation's
  parser and rejects any option it does not declare, so a flag a bundle added
  would fail `dsh web` before this plugin loaded. Per-invocation overrides read
  `DSH_RELAY_*` from the environment through the patch's `!!js` expressions.
