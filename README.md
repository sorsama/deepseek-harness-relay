![dsh-relay](banner.jpg)

# dsh-relay

[![npm](https://img.shields.io/npm/v/dsh-relay)](https://www.npmjs.com/package/dsh-relay)
[![CI](https://github.com/sorsama/deepseek-harness-relay/actions/workflows/ci.yml/badge.svg)](https://github.com/sorsama/deepseek-harness-relay/actions/workflows/ci.yml)

Use your [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) from your phone without opening it up to everyone on your Wi-Fi.

dsh-relay is a plugin for the harness's web profile. It puts HTTPS, a password, and device pairing in front of the harness, so you can reach it from another device on your network, or from anywhere if you forward a port.

It's built on DeepSeek Harness, but it isn't an official DeepSeek project.

## Why this exists

The harness web app only listens on `127.0.0.1`, so only the computer running it can open it. That's deliberate. The harness is a coding agent that runs commands on your machine, and its authors refuse `dsh web --host 0.0.0.0` because it "would expose remote code execution to the network".

The common workaround is a config patch that binds the harness to `0.0.0.0` with no sign-in at all. After that, anyone on the same Wi-Fi can drive your agent and run commands on your computer.

dsh-relay is the safer way to do it. The harness stays on loopback, and the relay runs as a second listener next to it. Every request gets TLS and a credential check before the relay forwards it.

```
phone / browser ──TLS──▶ relay :3443 ──plain HTTP──▶ harness 127.0.0.1:3080
                          ├─ /relay/password
                          ├─ /relay/login
                          ├─ /relay/pair
                          ├─ /relay/devices
                          └─ everything else ─proxy─▶ /api · WebSocket downlinks · web UI
```

Because the harness never leaves loopback, a relay that crashes or is misconfigured leaves the harness unreachable from the network, never open to it. The relay also refuses to start if it finds the harness already listening on a network address.

Harness 0.1.2 and later have a sign-in of their own (a browser session cookie). They still refuse to bind to the network, still have no TLS, and only hand out that cookie on their own page, so a phone still has no safe way in without something like this relay.

## What you get

- Password sign-in from any browser. Too many wrong guesses lock that address out for a while.
- Pairing by QR code or an 8-digit code. Each paired device gets its own token, and you can revoke any device on its own. Codes are single-use, expire after five minutes, and can only be created on the machine running the harness.
- A "sign out everywhere" button that rotates the signing key and logs out every browser and device at once.
- HTTPS, with your own certificate or a self-signed one whose key apps can pin.
- mDNS advertisement on `_dsh._tcp`, so apps can find the relay without scanning your subnet.
- The full harness web UI, unchanged, with a small **Relay** link in the corner.
- A settings page at **Plugins → dsh-relay → Configure** on the machine running the harness. Changes apply when you press Save, with no restart.

## Supported harness versions

| Harness | dsh-relay |
|---|---|
| 0.1.7-rc.2 through 0.2.x | **0.3** (tested on 0.2.1-rc.3, 0.2.0-rc.2, and 0.1.7-rc.2) |
| 0.1.2 through 0.1.5 | 0.2, installed from its git tag: `dsh plugin --profile web add github:sorsama/deepseek-harness-relay#v0.2.1`. The 0.2.1 package on npm shipped a stale build that can't authenticate to the harness. |
| 0.1.1 and earlier | 0.1 |

If you install a version that doesn't match your harness, the harness refuses to load it and tells you which range it needs. 0.3 depends on the settings system added in harness 0.1.7, and 0.2 hangs the web app on 0.1.7 and later, so the two can't overlap.

## Quick start

New to this? [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md) walks through every step with `npx @deepseek-ai/dsh web`, including what you'll see along the way.

1. **Remove the LAN patch if you have one.** If `~/.dsh/profiles/web/cordis.patch.yml` binds the harness to `0.0.0.0`, delete that row. The relay won't start in front of a harness that's already open to the network.

2. **Install the plugin and restart the harness.**

   ```sh
   dsh plugin --profile web add dsh-relay
   dsh web
   ```

   The package ships prebuilt, so nothing compiles on your machine. When the harness starts, it prints the relay's address.

3. **Set a password.** On the machine running the harness, open `https://127.0.0.1:3443/relay/password`. Until a password exists, this page only works from that machine, so nobody on your network can claim the relay first.

4. **Pair your phone.** Still on that machine, open `https://127.0.0.1:3443/relay/pair`. Scan the QR code with your phone, or open the same path on the phone and type the code. Give the device a name, and it shows up under `/relay/devices`.

No `dsh` on your PATH? Every command works as `npx @deepseek-ai/dsh ...` instead.

You won't be asked for a password on the machine running the harness. Anyone sitting at that keyboard already has a shell, so the relay treats loopback as you. The password is for everything else on the network.

## Using it with DSH Mobile

[DSH Mobile](https://github.com/sorsama/deepseek-harness-mobile) 0.8.0 and later support the relay fully. Go to **Relay → Pair a relay** in the app and scan the QR code or type the code. The app keeps a real token, uses HTTPS, and pins the relay's key, so there's nothing else to set up.

Once every app you use is on 0.8.0 and paired, turn off the compatibility bridge in your config:

```yaml
compat:
  addressGrants: false
```

<details>
<summary>Using DSH Mobile 0.5.0 to 0.7.0</summary>

These older versions came out before the relay existed, and they have two limits.

They can't connect to a self-signed HTTPS server. Up to 0.6.0 the app only spoke `http://`. 0.7.0 added `https://`, but only for certificates signed by a trusted authority, which a self-signed relay's isn't. To support them, run a plain HTTP listener next to the HTTPS one:

```sh
DSH_RELAY_PLAIN_PORT=3444 dsh web
```

That listener has no sign-in or pairing pages and can never reach the harness settings or credentials.

They also can't send any credential: no `Authorization` header, no cookies, no `Origin`. So instead, you pair from the phone's browser, the relay remembers the phone's network address, and the app is let in when it connects from that same address.

A network address isn't real authentication. It's shared behind NAT, changes with DHCP and IPv6 privacy addresses, and anything on the same Wi-Fi can spoof it. The relay limits the damage (private addresses only, a one-day expiry, removed when you revoke the device, never allowed into settings), but the real fix is updating the app.

</details>

If you're writing your own client, [docs/CLIENT_INTEGRATION.md](docs/CLIENT_INTEGRATION.md) is the protocol to follow.

## Configuration

There are three places to change settings:

- The settings page at **Plugins → dsh-relay → Configure**, on the machine running the harness.
- Environment variables for a single run, such as `DSH_RELAY_PORT=8443 dsh web`. There are no `--relay-*` command-line flags, because the harness rejects any flag it doesn't know.
- A `relay` row in `~/.dsh/profiles/web/cordis.patch.yml` for permanent changes.

[docs/CONFIGURATION.md](docs/CONFIGURATION.md) lists every option, plus how to set up certificates and how to reach the relay from the internet.

### Before you expose it to the internet

Read the [internet section of the configuration guide](docs/CONFIGURATION.md#reaching-the-relay-from-the-internet) first. The short version:

- Forward the relay's port, never the harness's.
- Use a real certificate.
- Set `compat.addressGrants: false` and `privilegedMethods: loopback-only`.
- Don't point Tailscale Funnel, Tailscale Serve, nginx, or Caddy at `127.0.0.1:3443`. Those proxies connect from loopback, and the relay treats loopback as you, so it won't ask anyone for a password.

## Security

Signing in to the relay gives you the same power as a shell on the host machine, because the agent runs commands there. Everything in this plugin is designed around that fact. [docs/SECURITY.md](docs/SECURITY.md) explains what the relay protects against, what it doesn't, and how to report a vulnerability.

## Documentation

| Guide | Read it when |
|---|---|
| [Getting started](docs/GETTING_STARTED.md) | You're setting up the relay for the first time. |
| [Configuration](docs/CONFIGURATION.md) | You want to change ports or certificates, or reach the relay from outside your network. |
| [Troubleshooting](docs/TROUBLESHOOTING.md) | Something isn't working. |
| [Security](docs/SECURITY.md) | You want to know exactly what the relay protects. |
| [Client integration](docs/CLIENT_INTEGRATION.md) | You're building an app that talks to the relay. |
| [Contributing](CONTRIBUTING.md) | You want to build, test, or change the plugin. |

## Development

```sh
pnpm install
pnpm build        # tsc -b, then tsdown
pnpm test
pnpm typecheck
```

[CONTRIBUTING.md](CONTRIBUTING.md) covers running a source checkout against a real harness and how releases work.

## Naming

The harness's brand guidelines ask community projects to use the `DSH` abbreviation instead of the full trademark, and not to use official brand art. That's why the npm package is `dsh-relay` and the relay's pages use this project's own logo.

## License

MIT
