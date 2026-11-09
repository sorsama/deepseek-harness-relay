# Troubleshooting

Find the symptom that matches yours. Commands use `dsh`; if you run the harness with `npx`, put `npx @deepseek-ai/` in front.

- [Installing and starting](#installing-and-starting)
- [Can't connect](#cant-connect)
- [Connected, but something's off](#connected-but-somethings-off)
- [DSH Mobile](#dsh-mobile)

## Installing and starting

### `ERR_PNPM_ADDING_TO_ROOT`

Your profile directory is a pnpm workspace root, and some pnpm versions want you to confirm you mean to add to it. Add `-w`:

```sh
dsh plugin --profile web add -w dsh-relay
```

### `dsh-relay declares no dsh.bundle`

The install didn't land properly. On Windows, the usual cause is installing from a local folder on a different drive from `~/.dsh`. pnpm writes a broken link in that case. Install from npm, or follow [Installing your checkout into a harness](../CONTRIBUTING.md#installing-your-checkout-into-a-harness), which uses a tarball.

### The harness refuses to load dsh-relay and names a version range

Your harness version is outside the range this release supports. Check [supported versions](../README.md#supported-harness-versions) and install the matching dsh-relay release.

### `error: unknown option '--relay-…'`

This is expected. The relay has no command-line flags. Use the [environment variables](CONFIGURATION.md#environment-variables) instead.

### "the harness web server is bound to …"

The relay only works in front of a harness that listens on loopback, and yours is listening on a network address. Two things cause this:

- The old DSH Mobile LAN patch, which sets `host: '0.0.0.0'` on the `webserver` row in `cordis.patch.yml`. Delete that row (see [Getting started, step 1](GETTING_STARTED.md#step-1-take-the-harness-off-the-network)).
- Starting the harness with `--host <address>`. From harness 0.2.1 that binds the harness itself to that address, so it's reachable without the relay. Drop `--host` and let the relay's `bind` setting decide what the network sees.

### "the harness web server is configured with tls"

The relay handles HTTPS itself and talks to the harness over plain HTTP on loopback. Remove `tls` from the `webserver` row and set the relay's own `tls` option instead.

### `overlay …\cordis.patch.yml must be a top-level YAML array`

You removed the last row from your config file and left only comments. Add `[]` on its own line.

## Can't connect

### The connection times out

Something is dropping the packets, usually a firewall. Windows puts networks it doesn't recognise into the Public profile, which blocks incoming connections. In an elevated PowerShell:

```powershell
New-NetFirewallRule -DisplayName "DSH Relay" -Direction Inbound `
    -Action Allow -Protocol TCP -LocalPort 3443,3444 -Profile Private,Domain
```

Then set the network to Private (Settings → Network & internet → *your network* → Network profile type).

If it still times out, check whether your router has AP or client isolation turned on. Guest networks almost always do. Also compare `ipconfig` on the computer with the IP address your phone reports. The first three numbers should match.

### My phone can't reach the address the relay printed

The relay prints an address for every network adapter, including virtual ones. `192.168.56.x`, for example, is VirtualBox's default, and your phone can't reach it. Use the address on the same network as your phone.

### Connection refused

Nothing is listening on that port. Check that the relay started:

```sh
netstat -ano | findstr 3443
```

Also make sure `DSH_RELAY_DISABLE=1` isn't set in your environment.

### 403 in the browser

The relay doesn't recognise the name you used to reach it. Use the IP address it printed at startup, or add the name to `publicHostnames`.

### Every request is refused, even `/relay/health`, and the log says `untrusted-host`

The relay only answers to loopback, its own addresses, and the names in `publicHostnames`. A request using any other name is refused, including the health check, so an app may report a running relay as missing. The log line shows the `Host` it refused. Add that to `publicHostnames`.

The one exception is the Android emulator's `10.0.2.2`, which the relay accepts automatically from a loopback connection (since 0.2.1).

### The port is still busy after Ctrl+C

Give it a moment. On shutdown, the relay force-closes WebSocket connections that are still open, which can take a second under load.

## Connected, but something's off

### The relay let me in without a password

That's expected on the machine running the harness. The relay treats loopback as you. Set a password at `/relay/password`, then try from another device to see the sign-in page.

### The QR scans, but the phone cannot connect

The QR encodes a network address, and the phone cannot use one it is not on. On the pairing page, pick the address under **Address your device can reach** and scan the new code. Each choice is labelled `<adapter> — <numeric IP>` (`Wi-Fi — 192.168.1.122`, `Tailscale — 100.121.55.94`), so pick the adapter your phone is on; a link-local address (`169.254.x.x`) only works on the same physical link and is labelled as such. If the page says no network address was found, this machine is on no network the phone shares — open the relay's address on the phone directly and type the code instead.

### `/relay/pair` on the harness port shows the pairing page

That is expected: the relay serves its own pages on the harness's own origin, too, which is how the **Relay** action changes the page in place. The relay's listener still serves them separately on port 3443.

### I can't find the relay's settings

They're at **Plugins → dsh-relay → Configure** on the `relay` row, and only on the machine running the harness, because the harness only offers settings to a loopback browser. From a phone, use the **Relay** link in the corner, or go to `/relay/devices`.

### The model picker is empty, and settings say "settings are unavailable in this browser"

This is expected on any address other than loopback, over HTTPS too, and the relay can't fix it. The harness web app checks `location.hostname` to decide whether settings exist. On a network address it never sends those requests, even though the relay would forward them. Chat, sessions, and workspaces still work.

Use a browser on the harness machine for settings, the provider directory, and model discovery. The fix belongs in the harness client; see [#4](https://github.com/sorsama/deepseek-harness-relay/issues/4).

### The page loads but the sidebar stays empty, and the console repeats `connection lost, retry #N`

Browsers only provide `crypto.randomUUID` over HTTPS or on `localhost`, and the harness web app needs it for every request. Over plain HTTP from a network address, its startup handshake fails and both event connections close before they open. Simple requests still work, which is why sign-in looks fine.

The relay adds a small fix for this to the page it serves. If you still see the problem, the page didn't come from the relay: hard-reload to skip a cached copy, and check that nothing in front of the relay serves its own `index.html`. Using HTTPS, or browsing from `127.0.0.1`, avoids the problem entirely.

### Everything returns 401, or the app says a stream wouldn't open

The relay couldn't create a harness browser session. Since 0.1.2 the harness requires a session for its whole API, and the relay signs one using the harness's own secret at `client-connection/browser-session`.

On the very first start, the relay often loads before the harness has written that secret, and logs `no harness browser-session secret yet`. From 0.3 it checks again on every request, and logs `harness browser session is available` once it finds it.

If you still get 401s after that line, something other than the relay is answering. Check that nothing is proxying straight to the harness's own port.

## Linking another PC

### Connect says the code is not valid

The code comes from the other computer's **Pair a device** page, works once, and expires after five minutes. Reload that page there and use the code it shows now.

### Connect says the certificate does not match the pin

The pin is optional, but if you typed one it must be copied exactly from the other computer's pairing page: 44 characters ending in `=`. Leave it empty to accept the certificate the other computer presents first. If a linked computer later changes its certificate, the link stops; unlink it and link again.

### A linked computer shows "not answering"

The Computers page probes each link while it renders. The other computer's relay port being firewalled, its address changing, or its VPN being down all show as "not answering". Open its relay in this browser first, then reload the Computers page.

### Open warns about the certificate, or seems to do nothing

The first visit to a linked computer's self-signed certificate needs one exception in the browser for that address. After that, the handoff signs this browser in and returns to that computer's harness. If **Open** is disabled, the computer is not answering; see above.

### Linking is refused everywhere

Turn on **Link with other computers** under **Plugins → dsh-relay → Configure** on both computers. Linking is also refused when either relay serves plain HTTP, or when the claiming relay is reached on loopback: use its network address.

## DSH Mobile

### "the harness rejected this address"

That's a 403. Either the address grant expired, or your phone's network address changed. Pair again from the phone's browser.

The relay never grants access to loopback or to an address the harness machine itself holds. If you paired through a proxy on the harness machine, or from that machine, the device is recorded without an address grant.
