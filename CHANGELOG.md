# Changelog

## 0.3.0

Harness **0.1.7** support. The settings card works again, and the plugin's
settings follow a live edit.

**A 0.2.x relay cannot show its settings card on 0.1.7 at all.** The relay
itself kept working — it loaded, bound its port, and proxied — which is what
made this worth writing down: every failure below is silent, and the operator
sees a working relay with no configuration page rather than an error.

### Fixed

- **The Plugins page served no namespace, so the card could never appear.**
  From 0.1.7 the settings plane reads an entry's schema off the object the
  Cordis loader registers — `entry.fiber.runtime.Config` — and the loader
  normalizes a module's exports to `exports.default ?? exports` first. This
  plugin exported a bare `apply` **function**; a function carries no `.Config`,
  so `settings/describe` listed zero namespaces and the browser half had
  nothing to attach to. Named exports are kept for compatibility, and the
  schema now also rides a default export object, which is what the loader
  reads.

- **Every field needed `.volatile()`, and a schema without it has no page.**
  0.1.7 builds the form with `volatileForm()`, which keeps only fields whose
  nearest marked ancestor is volatile, and `describe()` drops any entry whose
  form came back `undefined`. The schema now marks every form field volatile;
  `stateDir` stays off the form, because the bundle patch derives it and an
  editable absolute path in a browser form is a way to have the relay write its
  state somewhere unexpected.

- **The browser half used a client service that no longer exists.**
  `settingsScope` was replaced by `configForms`, and the old name appears in no
  0.1.7 client bundle — the bundle simply never loads, with no error anywhere.

- **The card registered into a slot that no longer exists.**
  `settings.plugin.item` was replaced by the Plugins page's `plugins.item`, and
  the manifest's `dsh.client.inject` now names the packages that own it
  (`-client-locale`, `-ui-plugin-manager`, `-ui-settings`) instead of
  `-ui-settings-plugins`.

- **The card drew its own frame.** The page now supplies the title button and
  the disclosure, so the card renders only the form body via the shared
  `SettingsForm` and `SettingsValueField`. The previous outer `<li>` with its
  own header produced a doubled card whose inner button sat over the platform's
  and swallowed its clicks.

- **A settings edit did not reach the running relay.** The provider's
  `settings.register(ns, schema, { base })` API is gone in 0.1.7; the namespace
  is the entry id and the config arrives already resolved. Worse, the
  replacement subscription was written against `settings.on`, which is
  `undefined` on a Cordis `Service` — optional-chained into subscribing to
  nothing, so an edit persisted to the profile patch and the listeners never
  rebound. Events are a **context** facility (`ctx.on`), which is how
  `dsh-api-remotes` forwards this same event. A listener now filters on this
  entry's own namespace and drives the supervisor, so a port change rebinds
  without a restart.

- **A cold start forwarded unauthenticated for the life of the process.** The
  relay mounts before `dsh-client-connection` has written its cookie-signing
  secret, read it **once**, and cached that single miss — after which every
  proxied request was answered 401 while the relay's own pages kept working, so
  a phone reported "the stream would not open" rather than a missing
  credential. The read is now per request, through a resolver that never
  memoizes a miss, which is what the credentials provider's own contract asks
  for: "Resolution is per call: consumers re-resolve at each operation and must
  not cache across operations." A rotated secret is picked up the same way, and
  the recovery is logged once. Deployments that carried a post-start script to
  force a reload for this reason can drop it.

  Measured on a real cold boot: the old build logged the miss and stayed
  unauthenticated with the secret already on disk; the new one logs
  `harness browser session is available; proxied requests now authenticate`
  with no restart and no config edit.

### Changed

- `@deepseek-ai/schemastery` is `^3.18.4` (the release that has `.volatile()`),
  `@deepseek-ai/cordis` is `>=4.0.4` (which re-exports the `Volatile` type),
  and the client/host harness packages are aligned to `0.1.7-rc.2`.
- The schema and the value diverge, so they are typed separately:
  `ConfigSchema` describes the live handles the loader resolves, and `Config`
  the plain values the plugin consumes. `plainConfig()` is the one boundary
  between them, and it reads the handles on every use — which is exactly what
  makes an edit visible to a running relay.
- The settings section gained a `settings-card` test suite that pins the two
  silent contracts above (the default export, and volatility per field). Both
  were checked by mutation: removing the default export, or dropping
  `.volatile()` from a single field, fails the suite.

### Declared compatibility: 0.1.7 and 0.2.0

The harness peer ranges are now `^0.1.7-rc.2 || >=0.2.0-rc.1 <0.2.1-0` rather
than an open `>=0.1.7-rc.2`, so the two generations this build was actually
verified against are the two it claims:

- **0.1.7-rc.2** — the target of this release; the card, the live settings
  follow, and the cold-start recovery were measured here.
- **0.2.0-rc.1 through 0.2.0** — audited by comparing both installs file by
  file, then driven end to end: the Host fence, password sign-in, session and
  device credentials, pairing, revocation, HTTP proxying with the harness
  session attached, and the WebSocket upgrade both with and without a
  credential. 15 functional checks pass, and a non-loopback client is refused
  without one.

`<0.2.1-0` is deliberate rather than a caret: it excludes the next minor so an
untested 0.3 does not install silently, while `0.2.0-rc.1`-and-later are
covered because the two 0.2.0 release candidates were compared and share every
file this plugin touches.

## 0.2.1

### Fixed

- **An Android emulator could not reach the relay at all.** The emulator dials
  its host machine at the fixed alias `10.0.2.2`, which is NAT'd to this
  machine's loopback — so the request arrived with `Host: 10.0.2.2:<port>` on a
  loopback socket, and the fence refused it as `untrusted-host` because that
  address never appears on any interface here and `localAddresses()` cannot
  report it. Nothing an operator could reasonably be expected to guess, and it
  made even the unauthenticated `/relay/health` probe answer 403, so the app
  reported a running relay as missing.

  The alias is now admitted, and only from a direct loopback peer — a
  forwarded request never receives the exemption, so a reverse proxy fronting
  the relay cannot inherit it. This does not weaken the DNS-rebinding defence:
  that attack turns on a browser sending an attacker's name as `Host`, and to
  be affected here a page would have to be fetching `http://10.0.2.2:<port>`,
  which does not reach this relay from an ordinary machine.

- **`untrusted-host` said nothing about which host.** The log line now names
  the refused `Host` and points at `publicHostnames`, so an operator with a
  relay answering 403 to everything can see what to add. It stays in the log
  and out of the response body: echoing it back would repeat an attacker's
  domain to the page that sent it.

## 0.2.0

Harness 0.1.2 support.

That release authenticates the harness's whole `/api` surface against a signed
browser-session cookie. The relay strips the client's own `Cookie` on the way
upstream — it authenticates the phone to the relay and means nothing to the
harness — so **without this release every proxied request is answered 401**. A
0.1.3 relay cannot serve a 0.1.2 harness at all.

### Added

- **A harness browser session on every proxied request.** The relay reads the
  harness's durable signing secret from the credential store they already
  share (`client-connection/browser-session`) and mints a short-lived,
  authority-bound cookie for the loopback authority it forwards to — on unary
  calls, on the session-log download, and on the `/api/remote.mux` upgrade,
  where a refusal would otherwise reach a phone as "the stream would not open".

  This is not a bypass. A plugin that can read `ctx.credentials` already runs
  with the operator's authority and could call any harness API in-process
  without a cookie; minting one only lets the relay speak the same HTTP
  contract as the browser.

  Against a harness older than 0.1.2 there is no such secret and none is
  needed; the relay logs that it is forwarding unauthenticated and carries on.

### Changed

- **`privilegedMethods` is the relay's own policy now, not a mirror.** Harness
  0.1.2 deleted its `PRIVILEGED_METHODS` list: there is no loopback-only method
  tier upstream any more, and one authenticated caller reaches the complete
  tool-capable API. This setting is therefore the only thing standing between a
  paired phone and the operator's settings and credential store — **set it to
  `loopback-only` if that is not what you want.**
- The pinned list is expressed in 0.1.2 endpoint names (`settings/update`) and
  keeps the 0.1.1 spelling (`settings.update`) beside each, so one build gates
  correctly against either harness. It also matches the whole endpoint rather
  than the first path segment, which two-segment 0.1.2 names require.

- The relay's own pages and its settings card now read as part of the harness
  rather than as a plugin bolted onto it.
  - **Every action is a control.** Navigation between the relay pages was a
    12px underlined browser-default link inside a caption — `THEME_CSS` had no
    `a` rule at all — which on the devices page put three equally important
    actions at three different weights. A `.btn` class now carries the
    harness's Button capsule onto an anchor, and the pages group their ways
    onward into action rows.
  - **The settings card follows the harness's plugin-card idiom.** A header
    button with a rotating chevron in place of a `details` triangle, the card's
    own 12px geometry, hairline-separated fields, an *Unsaved* pill, and a
    footer that appears only when there is something to write.
  - **Switches stage rather than commit as they settle.** Each was a `select`
    that wrote on change, so a change of mind rebound the listeners several
    times over; they are segmented buttons now, written together by **Save**
    and dropped by **Discard**. A save that does not land keeps its drafts and
    says so.
  - The card rendered a `details` as a direct child of the tab's `ul`. It
    renders an `li`, as every neighbouring card does.
  - A relay page taller than the viewport could not be scrolled to its bottom:
    the card was centred with `align-items`, which clips a flex item past the
    top of the viewport. It is centred with auto margins instead.
  - An error notice was drawn on the amber warn surface, so an error and a
    warning looked alike. Upstream has no error-tertiary token; the pages
    define one from its red palette.
  - The pages carry the harness's scrollbar skin, its elevation tokens, and a
    `StateDot` treatment on the status dots.
  - The corner **Relay** link sat at 0.55 opacity, legible only on hover.

### Fixed

- The pinned list claimed to be "checked for drift at startup". No such check
  existed, and none can now — there is nothing upstream left to check it
  against. The comment said so; the code did not.

- Three places still assumed the only mobile client was one that could carry no
  credential. [DSH Mobile
  0.8.0](https://github.com/sorsama/deepseek-harness-mobile/releases/tag/v0.8.0)
  implements `docs/CLIENT_INTEGRATION.md` in full, so each was wrong in a way
  someone would act on.
  - **`compat.plainPort` was refused whenever `addressGrants` was off**, on the
    reasoning that the plain listener served only address-granted clients —
    while `COMPAT_POLICY.accepts` has always included the `device` class. So
    turning grants off, which the security notes ask for, also took away a
    listener a paired client reaches perfectly well. The assertion is gone.
  - **A locked-out pairing attempt answered 403 `pairing-failed`**, because
    `pair()` collapsed the lockout into the same `undefined` a wrong code
    returns. That sends someone to reload the pairing page for a fresh code —
    the one thing that cannot help — spending another attempt to learn the same
    thing. It now answers 429 with a `Retry-After`.
  - **A sign-in lockout answered 429 with no `Retry-After`**, which
    `docs/CLIENT_INTEGRATION.md` promises is set. The rate limiter set it and
    this path did not, and the two are indistinguishable from outside, so a
    client that believed the contract busy-retried against a lockout.
  - The docs stop describing 0.5.0 as *the* client: the current path is "pair in
    the app, then turn `addressGrants` off", with the older releases folded into
    a collapsed section that says what they cost.

## 0.1.3 — 2026-08-27

- A browser reaching the web UI over plain HTTP from anything but loopback
  never got a live page: sign-in worked, then sessions, workspaces, and the
  model picker stayed empty behind `[web-runtime] connection lost, retry #N`,
  forever (#4). `crypto.randomUUID` is a secure-context API — HTTPS or
  `localhost`, nowhere else — and the harness's browser client mints every RPC
  correlation id with it, so `host.describe` threw inside the readiness
  handshake, the connection generation aborted, and both `/api/events.*`
  sockets were closed while still connecting. Every unary call kept working,
  which is exactly what made it look like the proxy damaging the WebSocket. The
  relay now injects a guarded shim into the index head, through the same
  `tapIndex` seam that carries the **Relay** link, defining `randomUUID` from
  `crypto.getRandomValues` where the browser withholds it. It defines nothing
  on a TLS listener or on the harness's own loopback port, and nothing in the
  proxy buffers a response to do it. The real fix belongs upstream in
  `AbstractApiClient.mintRpcId`.
- A remote browser still gets no model picker, provider directory, or settings
  pages, over TLS as well as plain HTTP: the harness's client decides whether
  the configuration plane exists from `location.hostname` alone, so it never
  makes the calls this relay would have carried. That is now written down under
  Troubleshooting rather than left to be rediscovered.

## 0.1.2 — 2026-08-23

- A reverse proxy on the same machine — Tailscale Funnel and Serve, nginx,
  Caddy — connects from `127.0.0.1`, and a loopback peer was the operator: no
  password, no pairing, and an exemption from the rate limit. Funnel's
  documented HTTP target is exactly that address, so its public URL served the
  harness to anyone (#1). A loopback request carrying a forwarding header
  (`Forwarded`, `X-Forwarded-*`, `X-Real-IP`, `Via`) is now classified as
  network traffic: it must present a credential, and it is throttled. A local
  browser sends none of those headers and is seated as before. The header is a
  tell, not a proof — the README still says to point a proxy at a non-loopback
  address.

## 0.1.1 — 2026-08-21

- `/relay/...` on the harness's own port answered with the single-page
  application, which routed straight back to the chat — so both a typed URL and
  the injected **Relay** link were dead ends there. The plugin now registers a
  redirect for that prefix on the harness's web server, carrying the path and
  query to the relay's listener. A request arriving through the relay is
  unaffected: the relay serves `/relay` itself and forwards only what it does
  not own.
- 0.1.0 was published before the documentation switched to the registry
  install, so its package page told readers to install from GitHub and warned
  about a build script that a registry install never runs.


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
