# Configuration

The relay works out of the box. Come here when you want a different port, your own certificate, or access from outside your home network.

## Three ways to change settings

| Way | Good for | Where |
|---|---|---|
| Settings page | Everyday changes | **Plugins → dsh-relay → Configure**, on the machine running the harness |
| Environment variables | One run only | `DSH_RELAY_PORT=8443 dsh web` |
| Config file | Anything permanent | A `relay` row in `~/.dsh/profiles/web/cordis.patch.yml` |

There are no `--relay-*` command-line flags, and there can't be. The harness web app owns the command line and rejects any option it doesn't know, so `dsh web --relay-anything` fails before any plugin loads.

## The settings page

Go to **Plugins → dsh-relay**, then press **Configure** on the `relay` row. The page has the listen address and port, the upstream timeout and rate limit, and switches for remote configuration access, the corner link, and mDNS. Edits are staged until you press **Save**. Saving restarts the relay's listeners in place, which drops any connections in flight, but the harness keeps running.

This page only appears on the machine running the harness. The relay doesn't choose that: the harness only offers settings to a browser on loopback, and decides by looking at the page's own address. A phone never sees a Configure button.

Everything you need from a phone lives on the relay's own pages instead. They work from any device, even before you've signed in:

| Page | What it's for |
|---|---|
| `/relay/devices` | Paired devices with revoke buttons, relay status, the certificate pin, and "sign out everywhere" |
| `/relay/pair` | The QR code and passcode for adding a device |
| `/relay/password` | Setting or changing the password |
| `/relay/health` | A health check that needs no sign-in |

The **Relay** link in the bottom-right corner of the harness UI opens these pages. Set `uiLink: false` to hide it.

## Environment variables

The relay's built-in config reads these, so they work without editing any file:

| Variable | What it does |
|---|---|
| `DSH_RELAY_PORT` | Port for the main listener (default `3443`) |
| `DSH_RELAY_BIND` | Address to listen on (default `0.0.0.0`) |
| `DSH_RELAY_TLS` | `self-signed`, `files`, or `off` |
| `DSH_RELAY_PLAIN_PORT` | Port for the plain HTTP listener; `0` turns it off |
| `DSH_RELAY_DISABLE=1` | Skip the relay for this run |

```sh
DSH_RELAY_PORT=8443 dsh web
```

## The config file

For permanent changes, add a `relay` row to `~/.dsh/profiles/web/cordis.patch.yml`. Your file is applied after the plugin's own, so your values win.

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

Your row replaces the plugin's whole `config` block. It doesn't merge with it. Two things follow from that:

- Restate every key you care about, including `stateDir`. It has no default, and the relay won't load without it.
- The environment variables above stop working for any key you write as a plain value, since they come from the plugin's own row. If you still want one, copy its expression from the shipped [`cordis.patch.yml`](../cordis.patch.yml), for example `port: !!js Number(process.env.DSH_RELAY_PORT ?? 3443)`.

Changes to this file apply without a restart. Installing or removing the plugin needs one.

## All options

| Option | Default | What it controls |
|---|---|---|
| `bind` | `0.0.0.0` | Address the main listener uses. |
| `port` | `3443` | Port the main listener uses. |
| `stateDir` | none (the plugin sets `~/.dsh/relay`) | Where the relay keeps its state, certificate, and key. |
| `tls` | `self-signed` | `files` for a certificate browsers trust, `self-signed` for apps that pin the key, `off` for plain HTTP. |
| `tlsCertPath` / `tlsKeyPath` | empty | Certificate and key files. Required when `tls` is `files`. |
| `publicHostnames` | `[]` | Extra names people use to reach the relay. They're added to the certificate and accepted as `Host` values. |
| `trustedHosts` | `[]` | More addresses the relay will answer to, as `host` or `host:port`. |
| `auth` | `both` | Which sign-in methods are accepted: `password`, `device-token`, or `both`. |
| `sessionTtlMs` | 12 hours | How long a browser stays signed in. |
| `deviceTokenTtlMs` | 30 days | How long a paired device's token lasts. |
| `pairingWindowMs` | 5 minutes | How long a pairing code can be used. |
| `pairingCodeLength` | `8` | Digits in a pairing code, from 6 to 12. |
| `maxFailedAttempts` / `lockoutMs` | 5 / 15 minutes | Wrong guesses allowed from one address, and how long it's locked out after that. |
| `rateLimitPerMinute` | `600` | Requests allowed per minute from one address. |
| `privilegedMethods` | `allow-authenticated` | Whether a signed-in remote device can reach harness settings, credentials, model discovery, and the host's folder pickers. Set `loopback-only` to keep those on the harness machine. Devices let in by address never reach them. On harness 0.1.2 and later this setting is the only thing guarding them, because the harness no longer restricts them itself. |
| `extraProxyPaths` | `[]` | More path prefixes (each starting with `/`) that a write request may go to. |
| `proxyTimeoutMs` | 2 minutes | How long to wait for the harness to answer a request. |
| `compat.addressGrants` | `true` | The bridge for DSH Mobile 0.5.0 to 0.7.0, which lets a device in by its network address. |
| `compat.addressGrantTtlMs` | 1 day | How long an address stays trusted. |
| `compat.plainPort` | `0` (off) | A plain HTTP listener for apps that can't use HTTPS. It accepts device tokens too, so it keeps working after you turn address grants off. |
| `uiLink` | `true` | Show the **Relay** link in the harness web UI. |
| `mdns` | `true` | Advertise the relay on your network as `_dsh._tcp`. |
| `mdnsName` | from your hostname | The name used in the mDNS advertisement. |

## Certificates

With the default `self-signed` setting, every browser shows a certificate warning. To get rid of it, give the relay a certificate your browser already trusts:

- On a home network, [mkcert](https://github.com/FiloSottile/mkcert) installs a local certificate authority and issues a certificate for your machine's IP address.
- On a public hostname, any ACME or Let's Encrypt certificate for that name works.

Then set `tls: 'files'` and point `tlsCertPath` and `tlsKeyPath` at the files.

Self-signed mode is meant for apps that pin the key. The relay publishes a SHA-256 fingerprint of its public key on the pairing page, on the devices page, and inside the QR code. An app that checks that fingerprint gets real transport security without any certificate authority. Browsers can't do that, which is why they warn. Because the fingerprint covers the key and not the whole certificate, renewing the certificate with the same key keeps paired devices working.

The relay writes its generated key with file mode `0600`. On Windows that setting does nothing, and the file takes the permissions of your harness home folder. If other people can read that folder, lock the file down with `icacls`, or use `tls: files` and manage the certificate yourself.

## Reaching the relay from the internet

Forward the relay's port, never the harness's. Then:

- Add the public name you'll use to `publicHostnames`. Otherwise the relay refuses requests addressed to it.
- Use a real certificate. Self-signed with pinning is fine on a home network, but not on the open internet.
- Turn off `compat.addressGrants`. Behind carrier-grade NAT, your public address is shared with strangers, and the relay won't trust a public address anyway.
- Set `privilegedMethods: loopback-only`. On harness 0.1.2 and later this is the only thing keeping settings and credentials away from remote devices, since the harness serves its whole API to anyone signed in.

### Reverse proxies

Don't point Tailscale Funnel, Tailscale Serve, nginx, or Caddy at `http://127.0.0.1:3443`. Those proxies connect from loopback, and the relay treats loopback as you, so it won't ask for a password or a device token.

Instead, point the proxy at an address the relay listens on that isn't loopback, such as your Tailscale IP or a VPC address. Keep `bind: 0.0.0.0`, and block port 3443 on your public network interface so that address doesn't become a second way in.

The relay does try to catch this mistake. When a loopback request carries a forwarding header (`Forwarded`, `X-Forwarded-*`, `X-Real-IP`, or `Via`), the relay treats it as network traffic, so it has to sign in and counts against the rate limit. Funnel, Serve, and Caddy always add `X-Forwarded-For`, so they get caught even in the setup above. But a proxy configured to strip those headers looks exactly like your own browser, so don't rely on this check. Use a non-loopback target.

To test your setup, request `/` through the public URL without signing in. You should get a **403**. If you get the harness page with a **200**, the proxy is connecting from loopback and hiding its forwarding headers, so move its target off loopback.

### Tailscale Funnel

Funnel handles HTTPS at its edge, so run the relay with `tls: off` behind it. The QR code at `http://127.0.0.1:3443/relay/pair` contains that loopback address, so it won't work from outside. To pair from outside, type the public `https://` address on the device instead of scanning. See [#1](https://github.com/sorsama/deepseek-harness-relay/issues/1) for more.
