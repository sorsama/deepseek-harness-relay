# Client integration

The contract a native client implements to authenticate against `dsh-relay`. Written for the [DSH Mobile](https://github.com/sorsama/deepseek-harness-mobile) Kotlin client, but nothing here is Android-specific.

A client that implements this needs no compatibility mode: it holds a real credential, so it can use TLS, connect from any address, and reach the full API.

## What changes for the client

Three things, and only three:

1. Send `Authorization: Bearer <token>` on every `/api` request **and on both WebSocket upgrades**.
2. Support `https://` as well as `http://`, and pin the certificate by SPKI when the relay is self-signed.
3. Obtain the token once, by scanning a QR code or entering a passcode.

Everything else — the envelope format, the method set, the two downlinks, the 3-second handshake budget — is unchanged, because the relay forwards to the same harness.

## The QR payload

A single JSON object, UTF-8, encoded directly into the QR. A scanner should check `kind` before doing anything with it.

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

| Field | Presence | Meaning |
|---|---|---|
| `v` | always `1` | Payload version. Refuse anything higher. |
| `kind` | always | Discriminator; must equal `dsh-relay-pair`. |
| `url` | always | Origin of the primary listener, scheme included. |
| `plainUrl` | optional | Origin of the plain-HTTP compatibility listener, when one is running. A client that implements this document should ignore it and use `url`. |
| `fingerprint` | optional | Base64 SHA-256 of the DER SubjectPublicKeyInfo. Absent when the relay serves plaintext. |
| `code` | always | The single-use pairing code. |
| `expiresAt` | always | Epoch milliseconds the code stops being claimable. |

The passcode flow is the same payload minus the QR: the user reads `code` off the screen and types it, and names `url` themselves.

## Claiming a code

```
POST {url}/relay/pair
Content-Type: application/json

{ "code": "48213977", "name": "Pixel 8" }
```

On success, HTTP 200:

```json
{
  "deviceId": "9f2c41ab30d7e155",
  "token": "hR9c...base64url...",
  "expiresAt": 1758092000000,
  "fingerprint": "3q2+7wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
}
```

On failure, HTTP 403:

```json
{ "error": "pairing-failed", "message": "That code is not valid." }
```

The code is consumed on success, so a second claim fails. Codes expire, and repeated failures lock the source address out for `lockoutMs`.

Store the token the way you would store a password. It does not expire on use and it is the whole credential.

## Authenticating

Every request:

```
Authorization: Bearer <token>
```

Both WebSocket upgrades carry the same header. This matters more than it looks: the client opens `/api/events.mux` and `/api/events.host` concurrently and gives them 3000 ms together before abandoning the connection generation. The relay verifies the token with one in-memory HMAC and adds no I/O to that path, so the budget is unaffected — but an upgrade sent without the header is refused at the handshake, and both downlinks must succeed.

## Status codes

The relay deliberately answers **403**, never 401, for every unauthorized case — including an expired or revoked token. DSH Mobile already maps 403 to "the harness is there and refused this address", which is a usable pairing hint, and maps other unexpected codes to "not a harness at all". A 401 would surface as the wrong diagnosis.

| Code | Meaning | What the client should do |
|---|---|---|
| 403 | No credential, expired, revoked, untrusted `Host`, cross-site marker, or a privileged method the credential may not reach | Prompt to pair again. Do not retry with backoff. |
| 404 | Path not proxied, or the harness does not compose that capability | Existing `capability-unavailable` handling applies. |
| 429 | Rate limited or locked out; `Retry-After` is set | Back off for the stated interval. |
| 502 | The harness behind the relay is not answering | Existing reconnect handling applies. |

## TLS

When `fingerprint` is present, pin it: compute SHA-256 over the DER SubjectPublicKeyInfo of the leaf certificate and compare against the base64 value from the QR. On Android that is `CertificatePinner` with a `sha256/<value>` pin — the same encoding.

Pinning the public key rather than the whole certificate means the relay can renew with the same key without breaking paired devices.

When `fingerprint` is absent, the relay is serving plaintext and the credential travels in the clear. A client should say so plainly in its UI.

Android note: reaching an `https://` origin needs no manifest change, but `network_security_config.xml` currently permits cleartext globally. A client that only ever talks to a pinned relay should narrow that.

## Revocation

There is no revocation callback. A revoked token starts failing with 403 on its next request, which the client already handles as "pair again". `Sign out everywhere` on the relay rotates the signing key and invalidates every token at once, with the same effect.

## Discovery

The relay advertises `_dsh._tcp` over mDNS when `mdns` is enabled. TXT records:

| Key | Value |
|---|---|
| `v` | `1` |
| `relay` | `dsh-relay` |
| `tls` | `self-signed`, `files`, or `off` |
| `plain` | port of the compatibility listener, when running |
| `pin` | base64 SPKI fingerprint, when the listener terminates TLS |

The service port is the primary listener's. A client that browses for this can skip the subnet sweep entirely; nothing depends on it, and the sweep keeps working.

## Checklist

- [ ] `https://` accepted as a base URL, for RPC and both WebSockets
- [ ] `Authorization: Bearer` on every RPC call and both upgrades
- [ ] QR scanner that validates `kind` and `v`
- [ ] Passcode entry as the fallback
- [ ] `POST /relay/pair` claim, with the token stored encrypted
- [ ] SPKI pinning when `fingerprint` is present
- [ ] 403 surfaces as "pair again", not as a transport failure
- [ ] mDNS browse for `_dsh._tcp`, sweep as the fallback
