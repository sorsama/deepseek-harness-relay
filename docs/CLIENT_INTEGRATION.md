# Client integration

This is what a native app needs to do to sign in to `dsh-relay`. It was written for the [DSH Mobile](https://github.com/sorsama/deepseek-harness-mobile) Kotlin app, but nothing here is specific to Android.

An app that follows this document doesn't need any compatibility mode. It holds a real credential, so it can use HTTPS, connect from any address, and reach the full API.

## What changes for the app

Compared with talking to the harness directly, an app needs three changes:

1. Send `Authorization: Bearer <token>` on every `/api` request **and on both WebSocket upgrades**.
2. Accept `https://` as well as `http://`, and pin the key (SPKI) when the relay uses a self-signed certificate.
3. Get the token once, by scanning a QR code or entering a passcode.

Everything else stays the same: the envelope format, the methods, the two downlinks, and the 3-second handshake budget. The relay forwards to the same harness.

## The QR code

The QR code holds a single UTF-8 JSON object. Check `kind` before doing anything with it.

```json
{
  "v": 1,
  "kind": "dsh-relay-pair",
  "url": "https://192.168.1.5:3443",
  "urls": ["https://192.168.1.5:3443", "https://10.0.0.4:3443"],
  "plainUrl": "http://192.168.1.5:3444",
  "fingerprint": "3q2+7wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  "code": "48213977",
  "expiresAt": 1755500000000
}
```

| Field | Present | Meaning |
|---|---|---|
| `v` | Always `1` | Payload version. Refuse anything higher. |
| `kind` | Always | Must equal `dsh-relay-pair`. |
| `url` | Always | Origin of the main listener, including the scheme. Always the one to try first, and always reachable from the network the operator chose — never loopback. |
| `urls` | Sometimes | Every origin that serves this same relay, `url` first. A client may fail over to the next entry when `url` does not answer; a client that ignores it still works. Added in 0.3.3; `v` stays `1`. |
| `plainUrl` | Sometimes | Origin of the plain HTTP compatibility listener, if one is running. An app that follows this document should ignore it and use `url`. |
| `fingerprint` | Sometimes | Base64 SHA-256 of the DER SubjectPublicKeyInfo. Missing when the relay serves plain HTTP. |
| `code` | Always | The single-use pairing code. |
| `expiresAt` | Always | When the code stops working, in epoch milliseconds. |

The passcode flow uses the same information without the QR code. The user reads `code` off the screen and types it, and enters the relay's address (`url`) themselves.

## Claiming a code

```
POST {url}/relay/pair
Content-Type: application/json

{ "code": "48213977", "name": "Pixel 8" }
```

On success, the relay answers HTTP 200:

```json
{
  "deviceId": "9f2c41ab30d7e155",
  "token": "hR9c...base64url...",
  "expiresAt": 1758092000000,
  "fingerprint": "3q2+7wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
}
```

On failure, it answers HTTP 403:

```json
{ "error": "pairing-failed", "message": "That code is not valid." }
```

A successful claim uses up the code, so claiming it again fails. Codes also expire, and too many failed attempts lock the source address out for `lockoutMs`.

Store the token the way you'd store a password. Using it doesn't wear it out, and it's the entire credential.

## Authenticating

Send this header on every request:

```
Authorization: Bearer <token>
```

Send it on both WebSocket upgrades too. This matters more than it looks. The app opens `/api/events.mux` and `/api/events.host` at the same time and gives them 3000 ms together before it gives up on that connection attempt. The relay checks the token with a single in-memory HMAC and does no I/O on that path, so it doesn't eat into the budget. But an upgrade without the header is refused during the handshake, and both downlinks have to succeed.

## Status codes

The relay always answers **403** for anything unauthorized, never 401. That includes expired and revoked tokens. DSH Mobile already reads 403 as "the harness is there and refused this address", which is a useful hint to pair again, and reads other unexpected codes as "this isn't a harness". A 401 would lead to the wrong diagnosis.

| Code | Meaning | What the app should do |
|---|---|---|
| 403 | No credential, expired or revoked credential, untrusted `Host`, cross-site marker, or a privileged method this credential can't reach | Ask the user to pair again. Don't retry with backoff. |
| 404 | The path isn't proxied, or the harness doesn't include that capability | Use the existing `capability-unavailable` handling. |
| 429 | Rate limited or locked out. `Retry-After` is set | Wait for the stated interval. |
| 502 | The harness behind the relay isn't answering | Use the existing reconnect handling. |

## TLS

When the QR code includes `fingerprint`, pin it. Compute SHA-256 over the DER SubjectPublicKeyInfo of the leaf certificate and compare it with the base64 value from the QR code. On Android, that's `CertificatePinner` with a `sha256/<value>` pin, which uses the same encoding.

Pinning the public key instead of the whole certificate means the relay can renew its certificate with the same key without breaking paired devices.

When `fingerprint` is missing, the relay is serving plain HTTP and the token travels unencrypted. The app should tell the user that clearly.

On Android, reaching an `https://` origin needs no manifest change. DSH Mobile's `network_security_config.xml` currently allows cleartext everywhere, though, and an app that only ever talks to a pinned relay should narrow that.

## Revocation

There's no revocation callback. A revoked token gets a 403 on its next request, which the app already treats as "pair again". "Sign out everywhere" on the relay rotates the signing key, which invalidates every token at once with the same result.

From relay 0.5.0, revoking also closes the device's open WebSockets, so a downlink ends at once instead of on its next reconnect. Treat that close like any other dropped downlink: reconnect, get the 403, and ask to pair again.

## Opening the harness web UI in a WebView

From relay 0.5.0. A WebView can't attach `Authorization: Bearer` to the requests its page makes on its own (scripts, `fetch`, WebSocket upgrades), so the app trades its token for a cookie the WebView carries instead.

### 1. Ask for a code

```
POST /relay/session/open
Authorization: Bearer <token>
Content-Type: application/json

{ "next": "/" }
```

The body is optional; without it the WebView lands on `/`. `next` must be a path on the relay's own origin. Anything else (another origin, `//host`, control characters, longer than 2048 characters) lands on `/` instead.

The answer:

```json
{
  "code": "<32 base64url characters>",
  "path": "/relay/session/enter?code=<code>",
  "url": "https://192.168.1.122:3443/relay/session/enter?code=<code>",
  "expiresAt": 1763891234567
}
```

`url` is built from the `Host` the app sent, so it names the same address the app is using. If the app reaches the relay through several addresses, load `path` against the origin the WebView will use.

| Code | Meaning |
|---|---|
| 200 | Here's a code. It works once, within 60 seconds. |
| 403 | No bearer token, an unknown, revoked, or expired one, or a credential that isn't a device token. A WebView cookie can't ask for a code, and neither can a password sign-in. Treat it as "pair again". |
| 413 | The body was over 64 KiB. |
| 429 | Rate limited. `Retry-After` is set. |

### 2. Load it in the WebView

Load `url` (or `path` against the relay's origin) as a top-level navigation the app starts itself, with `WebView.loadUrl`. The relay answers:

```
HTTP/1.1 303 See Other
Location: /
Set-Cookie: dsh_relay_device=<value>; Path=/; HttpOnly; SameSite=Strict; Max-Age=<seconds>; Secure
Referrer-Policy: no-referrer
```

`Secure` is there whenever the relay serves TLS. `Location` is the `next` you asked for. The WebView follows the redirect with the cookie already set, and from then on the page, its API calls, and both WebSocket downlinks ride the cookie.

Start the navigation from the app, not from a page on another origin. `SameSite=Strict` cookies don't ride a redirect chain another site started, so a link from elsewhere would set the cookie but land signed out.

If the WebView can't take the redirect, the app can do it by hand: `GET` the URL with redirects off, take the `Set-Cookie` header, and hand it to `CookieManager.setCookie(<relay origin>, <header value>)` before loading `next`. `CookieManager` accepts an `HttpOnly` cookie that way.

A code that was already used, has expired, was never issued, or whose device was unpaired gets a **403**: an HTML page, or `{ "error": "handoff-failed", "message": "…" }` when the request asks for JSON. Ask for a new code; don't retry the old one.

### 3. Keep it working

- **Lifetime.** The cookie lasts as long as a sign-in (`sessionTtlMs`, 12 hours by default) and never past the device token's own expiry. `Max-Age` says exactly how long. There's no refresh: ask for a new code whenever the app creates the WebView, which is cheap.
- **When it ends.** An expired or revoked cookie makes the next page load redirect to `/relay/login?next=…`, and the next API call or upgrade get a 403. Watch for a navigation to `/relay/login` (`shouldOverrideUrlLoading`) and run the handoff again instead of showing that page. If the app's own token also gets a 403, the device was unpaired: ask to pair again.
- **Revocation.** Unpairing the device ends the cookie on its next request and closes the WebView's WebSockets at once.
- **Scope.** The cookie is the device, nothing more: the same harness access as the token, with `privilegedMethods` applied the same way. The relay's own pairing, device, computer, and sign-out pages refuse it. The plain compatibility listener refuses it too, so the WebView must use the TLS origin.
- **Expected 403s under `loopback-only`.** The harness's own web client asks for `credentials/describe` while it boots, and the relay refuses that for every remote client under `loopback-only`. The page still loads and connects; only the features that read credentials go without. Don't treat those 403s as "pair again": only a 403 on the app's own bearer calls means that.
- **Origin.** The cookie belongs to the host the WebView loaded. Keep the WebView on that one origin and block navigation anywhere else.

### Hiding the Relay link

The relay adds a small **Relay** link to the bottom-right corner of the harness UI. An embedding page hides it by marking its `<html>` element with `data-dsh-relay-badge="off"`. Do it from a document-start script (`WebViewCompat.addDocumentStartJavaScript`) so the link never paints:

```js
(function () {
  function mark() { document.documentElement.setAttribute('data-dsh-relay-badge', 'off') }
  if (document.documentElement) { mark(); return }
  // Some document-start hooks run before the parser has made <html>.
  new MutationObserver(function (_, observer) {
    if (document.documentElement) { mark(); observer.disconnect() }
  }).observe(document, { childList: true })
})()
```

The fallback matters: in desktop Chromium, a document-start script injected through DevTools ran before `<html>` existed. The relay serves the same page either way; this is a stylesheet rule, not a different response.

### Plugin item targets (`ui-sync`)

The `dsh-ui-sync` companion keeps where each web plugin item shows in the settings namespace `ui-sync`. Both the WebView page and the app can read and write it, through the harness's own settings calls on the relay:

```
POST /api/settings/describe
Content-Type: application/json

{ "type": "client-request", "rpcId": "<uuid>", "method": "settings/describe", "payload": { "args": {} } }
```

```
POST /api/settings/mutate
Content-Type: application/json

{ "type": "client-request", "rpcId": "<uuid>", "method": "settings/mutate",
  "payload": { "args": { "ns": "ui-sync", "ops": [ { "op": "set", "path": ["targets", "<item id>"], "value": "phone" } ] } } }
```

Send the bearer token (the app) or the cookie (the WebView page). With `privilegedMethods: allow-authenticated` these are ordinary calls. With `loopback-only` the relay allows exactly these two, for exactly this namespace (unless the operator turned it off, [below](#when-the-operator-turns-ui-sync-off)):

- `settings/describe` must have empty `args`. The answer has the harness's usual shape, `{ "type": "server-response", "rpcId", "result": { "ok": true, "value": { "writable", "hasDocument", "namespaces": [...] } } }`, with `namespaces` cut down to the `ui-sync` entry (an empty list when the companion isn't installed).
- `settings/mutate` must name `"ns": "ui-sync"` exactly, with an `ops` array and optionally a numeric `expectedRevision`. Any other namespace or argument is refused before the harness sees it.
- The body must be uncompressed `application/json`.

| Code | Meaning |
|---|---|
| 200 | The harness's answer. A refusal from the harness itself arrives as `"result": { "ok": false, "error": { "code", "message" } }`. |
| 400 | The body isn't JSON. |
| 403 | Another namespace, an argument the relay doesn't check, a mismatched envelope, a method other than `POST`, an address-granted client, or any other settings, credentials, or host method under `loopback-only`. |
| 413 | The body was over 256 KiB. |
| 415 | Not `application/json`, or compressed. |
| 502 | The harness didn't answer, or answered `settings/describe` in a shape the relay can't filter. The relay never passes an unfiltered answer through. |

### When the operator turns ui-sync off

With `uiSyncSettings: false` and `privilegedMethods: loopback-only`, both calls answer 403 with `{ "error": "forbidden" }` before the harness sees them, the same as any other pinned method. Treat that as "placement is managed on the computer": show the add-ons read-only rather than as an error, and don't retry. The WebView handoff and everything else keep working.

The companion has no item-list call of its own: the item list comes from the WebView page over the bridge. A future `uiSync/*` call would need no relay change, because only the methods on the [privileged list](SECURITY.md#privileged-methods) are held back.

## Discovery

When `mdns` is on, the relay advertises `_dsh._tcp` over mDNS with these TXT records:

| Key | Value |
|---|---|
| `v` | `1` |
| `relay` | `dsh-relay` |
| `tls` | `self-signed`, `files`, or `off` |
| `plain` | Port of the compatibility listener, when it's running |
| `pin` | Base64 SPKI fingerprint, when the listener uses TLS |

The advertised port is the main listener's. An app that browses for this service can skip scanning the subnet. Nothing depends on it, and scanning keeps working.

## Checklist

- [ ] `https://` accepted as a base URL, for RPC and both WebSockets
- [ ] `Authorization: Bearer` on every RPC call and both upgrades
- [ ] QR scanner that checks `kind` and `v`
- [ ] Passcode entry as the fallback
- [ ] `POST /relay/pair` claim, with the token stored encrypted
- [ ] SPKI pinning when `fingerprint` is present
- [ ] 403 shown as "pair again", not as a connection failure
- [ ] mDNS browse for `_dsh._tcp`, with a subnet scan as the fallback
- [ ] For a WebView: a fresh `POST /relay/session/open` code each time it's created, loaded with `loadUrl`
- [ ] For a WebView: a navigation to `/relay/login` caught and answered with a new handoff
- [ ] For a WebView: `data-dsh-relay-badge="off"` set at document start, navigation kept to the relay's origin
