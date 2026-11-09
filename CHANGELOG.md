# Changelog

## 0.4.0 — 2026-11-09

### Added

- **Remote PC to PC.** A second harness computer can now be linked from the new
  **Computers** page, in either direction. **Share this PC** was the relay's
  only role; **Connect to another PC** records a mutual link, so both Computers
  pages list the pair, and **Open** hands this browser a single-use session on
  the other computer without retyping its password. Each link carries one token
  per direction and pins the other computer's certificate; every later call is
  checked against both. Linking needs TLS on both sides and is refused on plain
  HTTP.
- The link's handoff is a single-use nonce, good for 60 seconds, and it sets an
  ordinary browser session on the other computer. A link token reaches only
  `/relay/peer/status` and `/relay/peer/open`; the harness proxy, the operator
  pages, and both WebSocket downlinks refuse it.
- `peersEnabled` (default `true`) and `peerTimeoutMs` (default `2000`) settings,
  on the settings page. Turning linking off answers 404 on the link endpoints
  and leaves the Computers page explaining why.
- **Sign out everywhere now drops computer links too**, along with every session
  and device token. Unlink on either side ends the pair; the other side's next
  call stops authenticating.

### Changed

- `state.json` is now version 2. A version 1 file is upgraded in place on the
  first start, keeping its paired devices, address grants, and certificate, so
  no phone has to pair again.

## 0.3.5 — 2026-11-09

### Fixed

- **A network that joins after startup now appears on the pairing page without
  a restart.** The address candidates were computed once, when the relay
  started. Connecting Tailscale (or docking, or joining Wi-Fi) after that left
  the page stale: a connected tailnet showed only the stopped adapter's
  link-local `169.254.x.x` address — and could keep showing addresses that no
  longer existed — until the whole harness restarted. The pairing page now
  reads the machine's interfaces when it renders, so `Tailscale — 100.x.y.z`
  is offered on the next page load. The list is computed only for the pairing
  page, never on proxied requests.

## 0.3.4 — 2026-11-09

### Added

- **The pairing page's address picker labels each address by adapter and
  numeric IP.** The list used to show full URLs, so a phone's picker read
  `https://[2405:9800:b521:f170:48fd:119e:a1e2:60a9]:3443` and two entries could
  look interchangeable. Each choice now reads `Ethernet — 192.168.1.122`,
  `Hyper-V — 172.17.112.1`, or `Tailscale — 100.121.55.94`. The full origin is
  still the option's value, so the QR and the "show this address" form are
  unchanged. Link-local addresses (`169.254.x.x`) say `Link-local`, because no
  other device on the network can use one.
- **Tailscale is verified before it is named.** An adapter called "Tailscale"
  is not proof: a VPN client or a renamed NIC can claim that string, and
  `100.64.0.0/10` is CGNAT that carriers also hand out. An address is shown as
  Tailscale only when it is inside Tailscale's own `fd7a:115c:a1e0::/48` ULA
  (either the address itself or another address on the same adapter, which is
  how macOS's unhelpfully named `utun` adapters are recognised) or is a
  `100.64.0.0/10` address on an adapter named Tailscale. An adapter named
  Tailscale whose address fails that check reads `Tailscale (unverified)`, and
  the page's caption says Tailscale is only shown for verified addresses.
  README and TROUBLESHOOTING now explain the labels.

## 0.3.3 — 2026-11-06

### Fixed

- **The pairing QR now names an address a phone can reach.** The pairing page
  is normally opened on the machine itself, so its origin is loopback, and the
  QR encoded `https://127.0.0.1:3443` — a scan that succeeds and then cannot
  connect. The page now lists the machine's network origins and picks the most
  likely one (real adapter over virtual adapter, never loopback); the pairing
  page's picker switches the QR to another interface. If the machine has no
  network address at all the page says so instead of pretending.

### Added

- **The relay's pages are served on the harness's own origin**, so the sidebar
  **Relay** action changes the page in place — inside the desktop app, in the
  same window — instead of opening a browser. The mobile discovery probe
  (`GET /relay/health` with a non-document `Accept`) still receives the 3xx it
  reads to find a relay; a document navigation never does.

### Changed

- The QR carries an optional `urls` list (the same relay at every reachable
  origin, `url` first) so a client may fail over. `v` stays `1`; clients that
  ignore the field are unaffected.

## 0.3.2 — 2026-11-06

### Added

- **A Relay action at the sidebar foot**, rendered just above the account
  launcher, so pairing, devices, and the password page are one click away
  instead of a URL you have to know. It opens the relay's pages in the system
  browser — never in the harness window, where the relay's self-signed
  certificate is a fatal navigation in the desktop app. A phone already viewing
  the harness through the relay gets a relative link into the same pages.
- The account popover (**Settings / Feedback / Sign out**) has no seat in
  harness 0.2.1 — its rows are a hardcoded list in
  `@deepseek-ai/dsh-client-ui-settings-account` — so the plugin takes the
  supported `sidebar.footer.action` seat beside it rather than reimplementing
  the account menu.

## 0.3.1 — 2026-11-06

### Fixed

- **The desktop app no longer fails to start after the relay is installed.**
  The plugin registered a redirect from the harness's own origin (`/relay/...`)
  to the relay's TLS listener. The desktop app's window is an Electron page,
  and a 302 onto the relay's self-signed certificate cannot be loaded
  (`ERR_CERT_AUTHORITY_INVALID`); Electron treats a failed main-frame
  navigation as fatal, so the app showed "The application could not start or
  stopped unexpectedly" and every restart landed on the same failed URL. The
  redirect is removed: `/relay/...` on the harness's own port now falls through
  to the harness, and the relay's pages are reached on the relay's own origin.
  The corner link still works there; on the harness port it is inert rather
  than fatal.

## 0.3.0 — 2026-10-24

Harness **0.1.7 through 0.2.x** support. On any of them the published 0.2.1
breaks the web UI outright: its browser half waits on a client service 0.1.7
removed, the boot counts that pending entry as a failure, and the page renders
nothing but `dsh-relay: pending (waiting for service: settingsScope)`
([#11](https://github.com/sorsama/deepseek-harness-relay/issues/11),
[#13](https://github.com/sorsama/deepseek-harness-relay/issues/13)). The npm
tarball of 0.2.1 also shipped a runtime older than its own sources, so it
could not authenticate to a harness 0.1.2 or later at all.

**Requires harness 0.1.7-rc.2 or later.** On harness 0.1.2 through 0.1.5,
stay on 0.2, installed from its tag
(`github:sorsama/deepseek-harness-relay#v0.2.1`) rather than from npm.

### Fixed

- **The web UI boots again on 0.1.7 and later, and the settings page is back.**
  The browser half injects `configForms` instead of the removed
  `settingsScope`, and registers on the relay's own row of the Plugins page —
  **Plugins → dsh-relay → Configure** — through `plugins.row.config`, keyed
  `dsh-relay#relay`. The 0.1.5 seat, `settings.plugin.item`, no longer exists.
  The page renders inside the platform's frame through the shared
  `SettingsForm` rather than drawing a card of its own.
- **The settings plane could not see the relay.** From 0.1.7 it reads an
  entry's schema off the loader's plugin object, which is the module's default
  export when there is one — and this module had none. It also lists only
  fields marked `.volatile()`, and drops a schema with none. The schema now
  rides a default export with every form field volatile; `stateDir` stays off
  the form.
- **A settings edit now reaches the running relay.** Saving rebinds the
  listeners in place, with no restart: the relay follows
  `loader/volatile-update`, which the loader sends to this plugin alone once
  the new values are under its handles.
- **A switch on the settings page took the page down.** The remote
  configuration, relay link, and mDNS switches staged fields the form model
  had no spec for, so the first click threw on the next render. Each switch
  now has a spec, shows its staged value, and saves as the schema's own type.
- **A cold start forwarded unauthenticated for the life of the process.** The
  relay mounts before the harness writes its cookie-signing secret, read it
  once, and kept the miss — so every proxied request was answered 401 while
  the relay's own pages kept working, and a phone reported a stream that would
  not open. The secret is now read from the request path: a miss is never
  kept, the first request after the secret exists carries it, and the log
  says so once.
- **The npm tarball could ship a stale runtime.** `prepare` skips a checkout
  whose bundles exist, so a publish packed whatever `lib/` held. `prepack` now
  rebuilds both halves, and `pnpm test:pack` — run in CI — poisons the runtime,
  packs, and reads the bytes inside the tarball.
- **A changed address set no longer orphans paired devices.** When the
  addresses the self-signed certificate covers changed at start — a VPN
  dropping, an IP moving — the relay re-issued the certificate with a **new
  key**, and every device pinning the old one failed until re-paired. The
  certificate is now re-issued on the stored key, so the pin survives; only a
  missing key file mints a new identity.
- **An address grant could cover far more than one phone.** A pairing claimed
  through a reverse proxy on this machine arrives from `127.0.0.1`, and one
  claimed on the machine itself from its own LAN address; granting either
  admitted every client of the proxy, or every container NAT'd through the
  host, without a credential. Grants are now refused on loopback and on this
  machine's own addresses, and one an earlier release recorded there is
  ignored.
- **Two pairings of one phone can be told apart** on `/relay/devices`
  ([#8](https://github.com/sorsama/deepseek-harness-relay/issues/8)): each row
  shows when it was paired beside when it was last seen, and the last four
  characters of its device id beside its name.

### Changed

- **The supported harness range is stated, and enforced by the harness.**
  `engines.dsh` and the `@deepseek-ai/dsh-*` peers read
  `>=0.1.7-rc.2 <0.3.0-0`; the old open `>=0.1.0-rc.7` claimed every release
  including the ones this build cannot run on. The harness refuses a plugin
  outside its range before the profile starts, with a message that names it.
- **The relay refuses a harness it cannot protect or reach.** It already
  refused one bound to `0.0.0.0`; it now refuses one bound to any non-loopback
  address, which 0.2.1's `--host` allows, and one serving TLS itself, which a
  plain loopback forward cannot speak to.
- `@deepseek-ai/schemastery` is `^3.18.5`, and the browser half is checked
  against the harness's own `dsh-client-ui-primitives` types.

### Verified

On Windows, each against a real harness in an isolated home, installing the
packed tarball:

- **0.2.1-rc.3, 0.2.0-rc.2, and 0.1.7-rc.2**: the cold start heals on the first
  request; the web UI boots with the browser half active; the settings page
  renders, a switch stages without error, and a port edit rebinds the relay
  without restarting the harness; the Host fence, pairing, the key pin, a
  bearer token on `/api` and on the `/api/remote.mux` upgrade, and no grant on
  the machine's own address.
- **0.2.1-rc.3** additionally: password sign-in from the LAN, revocation, the
  pin and password surviving a restart, and the refusal to front a harness
  started with `--host <LAN address>`.

Thanks to @snailium (#10), @makhammadzhanov (#6), @hazyumps (#12, #14), and
@js-easy-school (#9) for the changes this release is built from, and to
@dimpurr, @johnlam1968, and @Cruzor-Blade for the reports and measurements in
#11 and #13.

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
