# Changelog

## 0.1.0 — unreleased

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
