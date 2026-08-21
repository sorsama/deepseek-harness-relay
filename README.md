# dsh-relay

Authenticated remote access for a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) web profile — reach your harness from your phone over Wi-Fi, or from anywhere if you forward a port, without leaving an unauthenticated coding agent open on the network.

Built on DeepSeek Harness. Not an official DeepSeek project.

## Why this exists

The harness serves its browser API on loopback and is explicit about what it does not do:

- `packages/client/connection/src/api-request-trust.ts` — the `/api` fence "is not an auth layer".
- `packages/client/connection/src/index.ts` — the configuration plane stays loopback-only "until a real authentication layer exists".
- `packages/bundle/web-app/src/startup.ts` — `dsh web --host 0.0.0.0` is refused, because "it would expose remote code execution to the network".

The workaround people use today is a config patch that rebinds the web server to `0.0.0.0` with no authentication at all. Anyone on the same Wi-Fi can then drive the agent, which means running commands on your computer.

`dsh-relay` is the missing layer, mounted beside the harness rather than inside it. The harness keeps its loopback bind; the relay is a second listener that terminates TLS, authenticates, and forwards.

```
phone / browser ──TLS──▶ relay :3443 ──plain HTTP──▶ harness 127.0.0.1:3080
                          ├─ /relay/password
                          ├─ /relay/login
                          ├─ /relay/pair
                          ├─ /relay/devices
                          └─ everything else ─proxy─▶ /api · WebSocket downlinks · web UI
```

Because the harness stays on loopback, a relay that fails to start or is misconfigured leaves the harness **unreachable** from the network — never open to it. The relay refuses to start at all if it finds the harness already bound to `0.0.0.0`.

## What you get

- **Password sign-in** for a browser, as a signed `HttpOnly; SameSite=Strict` cookie over a scrypt hash, with per-address lockout.
- **QR and passcode pairing** for devices, minting a revocable bearer token. Codes are single-use, short-lived, and can only be issued from the machine running the harness.
- **A device list** with per-device revoke and a "sign out everywhere" that rotates the signing key.
- **TLS**, either from your own certificate or self-signed with a published SPKI pin.
- **mDNS advertisement** on `_dsh._tcp`, so a client can find the relay without sweeping the subnet.
- **The whole web UI**, unchanged. The proxy is transparent, so the browser app works from a phone exactly as it does locally, with a **Relay** link in the corner for the pages above.

## Install

**New here? Start with [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md)** — a step-by-step walkthrough for `npx @deepseek-ai/dsh web`, including the LAN patch you have to remove first.

The short version. If your harness currently binds `0.0.0.0` (the DSH Mobile LAN patch), remove that row from `~/.dsh/profiles/web/cordis.patch.yml` first — the relay refuses to start in front of an already-open server. Then:

```sh
dsh plugin --profile web add github:sorsama/deepseek-harness-relay
dsh web
```

No `dsh` on your PATH? Every command works the same as `npx @deepseek-ai/dsh ...`.

The install builds from source in a `prepare` script, and adding a bundle needs a restart. The terminal then prints the relay URL. Open `/relay/password` on it **from the machine running the harness** and set a password — until one exists that page is loopback-only, so nobody on the network can claim the relay first.

A request from that machine never has to sign in: loopback is the operator, because whoever is at the keyboard already has a shell. The password is what the network needs.

## Pair a phone

1. On the machine running the harness, open `https://127.0.0.1:3443/relay/pair`.
2. Scan the QR with the phone, or open the same path on the phone and type the code.
3. Name the device. It is now enrolled, and appears under `/relay/devices`.

## Using it with DSH Mobile

[DSH Mobile](https://github.com/sorsama/deepseek-harness-mobile) 0.5.0 predates this plugin and has two limits the relay works around rather than pretends away:

**It cannot speak TLS.** The app hardcodes `http://` for its RPC calls and both of its WebSocket downlinks, so it cannot reach a TLS listener. Run a plain listener alongside the TLS one:

```sh
DSH_RELAY_PLAIN_PORT=3444 dsh web
```

The plain listener accepts only compatibility clients, serves no sign-in or pairing pages, and never reaches the harness settings or credentials.

**It cannot present a credential.** The app sends no `Authorization` header, no cookies, and no `Origin` — there is no field in it that could carry a token. So pairing from the phone's *browser* records that phone's network address, and the app then connects from the same address.

Be clear-eyed about what that is: a source address is **not** authentication. It is shared behind NAT, reassigned by DHCP, rotated by IPv6 privacy extensions, and spoofable by anything on the same Wi-Fi. The relay narrows it as far as it can — private address ranges only, a TTL, dies with the device that created it, and never reaches the configuration plane — but it is a bridge until the app can hold a token, not a destination. Turn it off with `compat.addressGrants: false` and pair a client that can authenticate.

`docs/CLIENT_INTEGRATION.md` is the contract for that client work.

## Configuration

Every value lives in your profile's `cordis.patch.yml` under the `relay` row. Your layer applies after the bundle's, so it wins. A patch replaces the row's **whole** `config`, so restate every key you want — including `stateDir`, which has no default.

```yaml
- id: relay
  name: 'dsh-relay'
  config:
    bind: '0.0.0.0'
    port: 3443
    stateDir: !!js dshHomePath('relay')
    tls: 'files'
    tlsCertPath: '/path/to/fullchain.pem'
    tlsKeyPath: '/path/to/privkey.pem'
    publicHostnames: ['relay.example.com']
    privilegedMethods: 'allow-authenticated'
    compat:
      addressGrants: true
      addressGrantTtlMs: 86400000
      plainPort: 3444
```

| Field | Default | What it decides |
|---|---|---|
| `bind` / `port` | `0.0.0.0` / `3443` | The primary listener. |
| `tls` | `self-signed` | `files` for a certificate a browser trusts, `self-signed` for pinning clients, `off` for plaintext. |
| `publicHostnames` | `[]` | Extra names this relay is reached by — certificate SANs, and accepted `Host` values. |
| `trustedHosts` | `[]` | Additional authorities the fence accepts, as bare `host` or `host:port`. |
| `auth` | `both` | Which credential classes are accepted. |
| `sessionTtlMs` | 12 h | Browser cookie lifetime. |
| `deviceTokenTtlMs` | 30 d | Device token lifetime. |
| `pairingWindowMs` | 5 min | How long a pairing code stays claimable. |
| `maxFailedAttempts` / `lockoutMs` | 5 / 15 min | Sign-in lockout. |
| `rateLimitPerMinute` | 600 | Per-address request ceiling. |
| `privilegedMethods` | `allow-authenticated` | Whether an authenticated remote client reaches settings, credentials, model discovery, and host pickers. Address-granted clients never do, regardless. |
| `extraProxyPaths` | `[]` | Additional path prefixes a write may address. |
| `compat.addressGrants` | `true` | The DSH Mobile 0.5.0 bridge described above. |
| `compat.plainPort` | `0` | Plain-HTTP listener for clients that cannot use TLS. |
| `uiLink` | `true` | Add the **Relay** link to the harness web UI. |
| `mdns` | `true` | Advertise `_dsh._tcp`. |

### Per-invocation overrides

**There are no `--relay-*` flags, and there cannot be.** The harness's web app owns the invocation's parser and rejects any option it does not declare, so a flag added by a bundle fails `dsh web` before any plugin loads. The shipped patch reads the environment instead:

| Variable | Effect |
|---|---|
| `DSH_RELAY_PORT` | primary listener port |
| `DSH_RELAY_BIND` | listen address |
| `DSH_RELAY_TLS` | `self-signed`, `files`, or `off` |
| `DSH_RELAY_PLAIN_PORT` | plain-HTTP listener port; `0` disables it |
| `DSH_RELAY_DISABLE=1` | skip the relay entirely this run |

```sh
DSH_RELAY_PLAIN_PORT=3444 dsh web
```

## Certificates

A phone browser will warn on a self-signed certificate. For browser use, point `tls: files` at something already trusted — [mkcert](https://github.com/FiloSottile/mkcert) on a LAN, or an ACME certificate on a forwarded name.

Self-signed mode exists for pinning clients: the relay publishes the SHA-256 of its SubjectPublicKeyInfo in the QR payload and on the devices page, and a client that pins that value gets real transport security with no certificate authority involved. The pin covers the public key rather than the certificate, so renewing with the same key leaves paired devices working.

The generated key is written mode `0600`. **On Windows that is a no-op** — the file inherits the ACL of your harness home. If that directory is shared, restrict it with `icacls` or manage the certificate yourself with `tls: files`.

## Exposing it to the internet

Forward the relay's port, not the harness's. Then:

- Set `publicHostnames` to the name you reach it by, or the fence will refuse the request.
- Use a real certificate. Self-signed plus pinning is a LAN answer.
- Leave `compat.addressGrants` off. Behind carrier NAT a public address is shared with strangers, and the relay refuses to grant one anyway.
- Consider `privilegedMethods: loopback-only`.

## Security model

Read `docs/SECURITY.md` for the full statement. The short version: **signing in grants the same power as a shell on the host machine**, because the agent runs commands there. Everything in this plugin follows from that.

## Troubleshooting

**Nothing answers, the connection times out.** The firewall is dropping packets. On Windows, an unrecognised network goes into the Public profile, which blocks inbound TCP:

```powershell
New-NetFirewallRule -DisplayName "DSH Relay" -Direction Inbound `
    -Action Allow -Protocol TCP -LocalPort 3443 -Profile Private,Domain
```

Set the network to Private. If it still times out, check the router for AP/client isolation — guest SSIDs almost always have it.

**Connection refused.** Nothing is listening. Confirm the relay started (`netstat -ano | findstr 3443`) and that `--no-relay` is not in effect.

**403 from the relay.** The `Host` you reached it by is not trusted. Connect by an IP literal the relay derived itself, or add the name to `publicHostnames`.

**The plugin refuses to start, naming the webserver row.** You still have the old LAN patch that binds the harness to `0.0.0.0`. Remove it — the relay cannot protect a server that is already answering the network.

**DSH Mobile says "the harness rejected this address".** That is a 403. Either the address grant expired or the phone's address changed; pair again from the phone's browser.

## Development

```sh
pnpm install
pnpm build        # tsc -b, then tsdown
pnpm test
pnpm typecheck
```

Point a source checkout at a running harness with an overlay that names the
built entry points directly:

```yaml
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

On Windows the path must be a `file://` URL, not a bare absolute path — the
loader hands it to the ESM resolver, which rejects a `d:` protocol.

## Naming

The harness's brand guidelines ask ecosystem projects to use the `DSH` abbreviation rather than the full trademark in their names, and not to present official brand art. The npm package is `dsh-relay` and the pages carry this project's own mark.

## License

MIT
