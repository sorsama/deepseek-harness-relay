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
| `url` | Always | Origin of the main listener, including the scheme. |
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
