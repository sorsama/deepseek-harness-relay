# Getting started with `npx @deepseek-ai/dsh web`

A walkthrough for the common setup: no `dsh` on your PATH, you start the harness with `npx`. Every command below is the `npx` form — if you do have `dsh` installed globally, drop the `npx @deepseek-ai/` prefix from all of them.

Verified end to end on Windows against `@deepseek-ai/dsh@0.1.0-rc.7`.

## 0. Where things live

| | |
|---|---|
| Harness home | `~/.dsh` (`C:\Users\<you>\.dsh`), or `$DSH_HOME` if you set it |
| Your web profile | `<home>/profiles/web/` |
| Your own config layer | `<home>/profiles/web/cordis.patch.yml` |
| What the relay stores | `<home>/relay/` — state, certificate, key |

`npx @deepseek-ai/dsh web` is shorthand for `--profile web`. `npx @deepseek-ai/dsh plugin --profile web <args>` forwards `<args>` to pnpm inside the profile directory, so every pnpm verb works there.

## 1. Take the harness off the network first

Open `~/.dsh/profiles/web/cordis.patch.yml`. If it contains a row like this:

```yaml
- id: webserver
  name: '@deepseek-ai/dsh-host-webserver'
  inject: [webStartup]
  config:
    host: '0.0.0.0'
    port: 3080
```

**delete that row.** It is the DSH Mobile LAN patch, and it serves your agent to everyone on your network with no authentication — the relay is what replaces it. The plugin refuses to load while it is in place, with this message:

```
dsh-relay: the harness web server is bound to 0.0.0.0, so it is already
reachable without authentication and this relay would protect nothing.
```

If that leaves the file with nothing but comments, put an empty list in it. The loader requires a top-level YAML array, and a file of comments alone parses as `null`:

```yaml
# nothing to override right now
[]
```

Confirm the harness is back on loopback:

```sh
npx @deepseek-ai/dsh web --dump-config
```

The `webserver` row should read `host: 127.0.0.1`.

## 2. Install the relay

```sh
npx @deepseek-ai/dsh plugin --profile web add dsh-relay
```

The published package ships prebuilt, so nothing compiles on your machine and no build permission is involved. It takes a few seconds. When it finishes, the profile manifest lists the bundle:

```jsonc
// ~/.dsh/profiles/web/package.json
{
  "dependencies": { "dsh-relay": "^0.1.0" },
  "dsh": { "profile": { "bundles": [
    "@deepseek-ai/dsh-base",
    "@deepseek-ai/dsh-web-app",
    "dsh-relay"          // ← appended last, so it layers over the web app
  ] } }
}
```

If you get `dsh-relay declares no dsh.bundle`, the install did not land — see [Installing from a local checkout](#installing-from-a-local-checkout) below, which is the usual cause on Windows.

To follow unreleased work instead, install from git and pin a commit so a later push cannot silently change what runs on your machine:

```sh
npx @deepseek-ai/dsh plugin --profile web add github:sorsama/deepseek-harness-relay#<sha>
```

That route builds from source in a `prepare` script, which pnpm may ask you to allow — see [Installing from a local checkout](#installing-from-a-local-checkout) for the same allowance.

## 3. Restart

Adding a bundle changes the layer stack, and a running profile keeps the stack it started with. Stop the harness (Ctrl+C) and start it again:

```sh
npx @deepseek-ai/dsh web
```

You should now see three extra lines before the usual harness URL:

```
[dsh-relay] listening on https://127.0.0.1:3443 https://10.0.1.20:3443 (harness on 127.0.0.1:3080)
[dsh-relay] no password set yet — open https://127.0.0.1:3443/relay/password on this machine to set one
dsh web: http://127.0.0.1:3080
```

Every address the machine has is listed, not a guess at the best one. If you run VirtualBox, WSL, or a VPN you will see their adapters here too — use the one on the same network as your phone. `ipconfig` tells you which is which.

## 4. Set a password

Open `https://127.0.0.1:3443/relay/password` **on the machine running the harness**. Your browser will warn about the certificate — that is expected on the default self-signed setting; accept it for now, and see [Certificates](#certificates) if you want that gone.

Until a password exists that page is loopback-only, so nobody on the network can reach the relay and claim it first.

Pick something long. Anyone who signs in can run commands on this computer, because that is what the agent does.

You can change it later from the same page, linked from `/relay/devices`.

**A request from this machine never has to sign in.** Loopback is the operator: whoever is at the keyboard already has a shell, so a password there would be theatre, and `https://127.0.0.1:3443/` drops you straight into the harness. The password is what the *network* needs. Browse to the relay from another device to see the sign-in page.

## 5. Pair your phone

1. Still on the harness machine, open `https://127.0.0.1:3443/relay/pair`.
2. Scan the QR with the phone, or open `https://<your-lan-ip>:3443/relay/pair` on the phone and type the 8-digit code.
3. Give the device a name.

The code works once and expires in five minutes. Paired devices are listed at `/relay/devices`, each with a revoke button.

Your phone browser can now reach the full harness UI at `https://<your-lan-ip>:3443/`.

## 6. If you use the DSH Mobile app

DSH Mobile 0.5.0 cannot speak TLS — it hardcodes `http://` for its API calls and both of its WebSocket streams — so it needs a second, plain listener:

```sh
DSH_RELAY_PLAIN_PORT=3444 npx @deepseek-ai/dsh web
```

Then pair from the phone's **browser** as in step 5 (over `https://…:3443`), and point the app at `<your-lan-ip>` port `3444`.

Pairing from the browser is what makes the app work: it records your phone's network address, and the app connects from that same address. The app itself has no field that can hold a token.

That is weaker than a real credential and the relay treats it that way — private addresses only, one day by default, gone when you revoke the device, and never able to reach the harness settings or credentials. It stops working when your phone's address changes, which happens on a Wi-Fi/cellular switch or a DHCP lease renewal; just pair again. See [SECURITY.md](SECURITY.md) for the full list of what a source address does and does not prove.

## Where the relay's settings are

**Settings → Plugins → Plugin configuration**, as a **Relay** card beside Shell
and Web search. It carries the switches — remote configuration access, the
corner link, mDNS — and links to the pages that carry the operations.

The card appears only on the machine running the harness. That is not a choice
this plugin makes: the harness serves its settings namespaces to a loopback
browser only, deciding from `location.hostname` on the page itself, so a remote
browser is dispatched no cards at all. Pairing, the device list, the
certificate pin, and the password therefore live on the relay's own pages
instead, which work from any device and before anyone has signed in:

| Page | What it does |
|---|---|
| `/relay/devices` | paired devices with revoke, relay status, the certificate pin, sign out everywhere |
| `/relay/pair` | the QR and the code for enrolling a device |
| `/relay/password` | set or change the password |
| `/relay/health` | liveness, no authentication |

A small **Relay** link in the bottom-right corner of the harness UI reaches
them. Turn it off with `uiLink: false`.

## Changing settings

**There are no `--relay-*` command-line flags, and there cannot be.** The harness's web app owns the invocation's parser and rejects any option it does not declare — `npx @deepseek-ai/dsh web --anything-it-does-not-know` fails before any plugin loads. So there are two ways to configure the relay.

**For one run**, environment variables the shipped patch already reads:

| Variable | Effect |
|---|---|
| `DSH_RELAY_PORT` | primary listener port (default `3443`) |
| `DSH_RELAY_BIND` | listen address (default `0.0.0.0`) |
| `DSH_RELAY_TLS` | `self-signed`, `files`, or `off` |
| `DSH_RELAY_PLAIN_PORT` | plain-HTTP listener port; `0` disables it |
| `DSH_RELAY_DISABLE=1` | skip the relay entirely this run |

```sh
DSH_RELAY_PORT=8443 npx @deepseek-ai/dsh web
```

**For anything permanent**, put a `relay` row in `~/.dsh/profiles/web/cordis.patch.yml`. Your layer applies after the bundle's, so it wins:

```yaml
- id: relay
  name: 'dsh-relay'
  config:
    bind: '0.0.0.0'
    port: 3443
    stateDir: !!js dshHomePath('relay')
    tls: 'files'
    tlsCertPath: 'C:/certs/relay.pem'
    tlsKeyPath: 'C:/certs/relay-key.pem'
    publicHostnames: ['relay.example.com']
    privilegedMethods: 'allow-authenticated'
    compat:
      addressGrants: true
      addressGrantTtlMs: 86400000
      plainPort: 3444
```

A patch replaces the row's **whole** `config`, so restate every key you want, including `stateDir` — dropping it fails the load, because it has no default. The full field list is in the [README](../README.md#configuration).

Config edits hot-reload; adding or removing the bundle needs a restart.

## Certificates

The default `self-signed` mode makes every browser show a warning. To get rid of it, give the relay a certificate the browser already trusts:

- **On a LAN** — [mkcert](https://github.com/FiloSottile/mkcert) installs a local authority and issues a certificate for your machine's IP.
- **On a forwarded name** — any ACME/Let's Encrypt certificate for the hostname.

Then set `tls: 'files'` with `tlsCertPath` and `tlsKeyPath` as above.

Self-signed mode exists for apps that pin: the relay publishes the SHA-256 of its public key on the pairing page and in the QR, and a client that pins that value gets real security with no authority involved. Browsers do not work that way, which is why they warn.

## Turning it off

```sh
npx @deepseek-ai/dsh plugin --profile web remove dsh-relay
npx @deepseek-ai/dsh web
```

Or keep it installed and skip it for one run with `DSH_RELAY_DISABLE=1`.

Removing the plugin leaves `~/.dsh/relay/` in place — delete that directory to forget the password, every paired device, and the generated certificate.

## Troubleshooting

**`error: unknown option '--relay-…'`** — expected. There are no relay flags; use the environment variables above.

**`dsh-relay: the harness web server is bound to 0.0.0.0`** — step 1. Remove the LAN patch row.

**`overlay …\cordis.patch.yml must be a top-level YAML array`** — you removed the last row and left only comments. Add `[]` on its own line.

**The relay let me straight into the chat without asking for a password.** Expected, if you opened it on the machine running the harness — loopback is the operator. Set the password at `/relay/password` and check it from another device.

**I can't find the relay in the harness Settings page.** Settings → Plugins → Plugin configuration, and only from the machine running the harness — the harness serves settings to a loopback browser only. From a phone, use the **Relay** link in the corner or go to `/relay/devices`.

**Your phone cannot reach the address the relay printed.** It prints every adapter, and a virtual one (`192.168.56.x` is VirtualBox's default) is not routable from your phone. Use the address on the same network your phone is on.

**Nothing answers from the phone, the connection just times out.** Windows puts an unrecognised network into the Public profile and blocks inbound TCP. In an elevated PowerShell:

```powershell
New-NetFirewallRule -DisplayName "DSH Relay" -Direction Inbound `
    -Action Allow -Protocol TCP -LocalPort 3443,3444 -Profile Private,Domain
```

Then set the network to Private (Settings → Network & internet → *your network* → Network profile type). If it still times out, check the router for AP/client isolation — guest networks almost always have it on. Compare `ipconfig` on the computer with the address the phone reports; the first three numbers should match.

**403 from the relay in a browser.** The name you typed is not one the relay answers to. Use the IP address it printed at startup, or add the name to `publicHostnames`.

**DSH Mobile says "the harness rejected this address".** That is a 403 — the address grant expired or your phone's address changed. Pair again from the phone's browser.

**The relay port is still busy after Ctrl+C.** Give it a moment; the relay force-closes held-open WebSocket connections during shutdown, which takes a beat under load.

### Installing from a local checkout

If you cloned the repo and want to install *that*:

```sh
npx @deepseek-ai/dsh plugin --profile web add ./deepseek-harness-relay
```

**On Windows this silently fails when the checkout is on a different drive from `~/.dsh`.** pnpm records the absolute path as a `link:` spec and then resolves it relative to the profile directory, producing a broken symlink like `C:\Users\you\.dsh\profiles\web\D:\LabTeto\...`. `dsh` then reports:

```
dsh: warning: dsh-relay declares no dsh.bundle — installed as a plain dependency, not a profile layer
```

Use a tarball instead, which is copied rather than linked:

```sh
cd deepseek-harness-relay
pnpm build && pnpm pack
npx @deepseek-ai/dsh plugin --profile web add ./dsh-relay-0.1.0.tgz
```

Or just install from GitHub, as in step 2.

### Developing against a running harness

Point an overlay at the built entry point instead of installing:

```yaml
# dev.cordis.yml
- insert:
    - id: relay
      name: 'file:///D:/path/to/deepseek-harness-relay/lib/index.js'
      config:
        stateDir: 'D:/path/to/scratch/relay-state'
        tls: 'off'
```

```sh
npx @deepseek-ai/dsh web --patch ./dev.cordis.yml
```

On Windows the plugin path must be a `file://` URL. A bare `D:/...` fails with `ERR_UNSUPPORTED_ESM_URL_SCHEME`, because the loader hands it to Node's ESM resolver, which reads `d:` as a protocol.
