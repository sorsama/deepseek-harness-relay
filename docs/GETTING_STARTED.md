# Getting started

This guide sets up dsh-relay on a harness you start with `npx @deepseek-ai/dsh web`, which is the most common setup. If you have `dsh` installed globally, drop the `npx @deepseek-ai/` prefix from every command.

You'll need harness 0.1.7-rc.2 or later for dsh-relay 0.3. On an older harness, install `dsh-relay@0.2` instead (see [supported versions](../README.md#supported-harness-versions)). These steps were last checked on Windows with harness 0.2.1-rc.3 and dsh-relay 0.3.0.

## Where things live

| What | Where |
|---|---|
| Harness home | `~/.dsh` (`C:\Users\<you>\.dsh` on Windows), or `$DSH_HOME` if you set it |
| Your web profile | `<home>/profiles/web/` |
| Your own config file | `<home>/profiles/web/cordis.patch.yml` |
| The relay's data (state, certificate, key) | `<home>/relay/` |

`npx @deepseek-ai/dsh web` is short for `--profile web`. `npx @deepseek-ai/dsh plugin --profile web <args>` runs pnpm inside the profile directory with your `<args>`, so any pnpm command works there.

## Step 1: Take the harness off the network

Open `~/.dsh/profiles/web/cordis.patch.yml`. If you see a row like this one, delete it:

```yaml
- id: webserver
  name: '@deepseek-ai/dsh-host-webserver'
  inject: [webStartup]
  config:
    host: '0.0.0.0'
    port: 3080
```

That's the DSH Mobile LAN patch. It serves your agent to your whole network with no sign-in, and the relay replaces it. While the row is there, the relay refuses to load and prints:

```
dsh-relay: the harness web server is bound to 0.0.0.0, so it is already
reachable without going through this relay, which would protect nothing.
```

If deleting the row leaves only comments in the file, add an empty list on its own line. The loader expects a YAML list, and a file with only comments counts as empty:

```yaml
# nothing to override right now
[]
```

Check that the harness is back on loopback:

```sh
npx @deepseek-ai/dsh web --dump-config
```

The `webserver` row should say `host: 127.0.0.1`.

## Step 2: Install the relay

```sh
npx @deepseek-ai/dsh plugin --profile web add dsh-relay
```

If pnpm stops with `ERR_PNPM_ADDING_TO_ROOT`, run it again with `-w` after `add`. The profile directory is a pnpm workspace root, and some pnpm versions want you to confirm that.

The npm package ships prebuilt, so nothing compiles and pnpm won't ask for build permission. It takes a few seconds. Afterwards, your profile's `package.json` lists the plugin as the last bundle:

```jsonc
// ~/.dsh/profiles/web/package.json
{
  "dependencies": { "dsh-relay": "^0.3.0" },
  "dsh": { "profile": { "bundles": [
    "@deepseek-ai/dsh-base",
    "@deepseek-ai/dsh-web-app",
    "dsh-relay"          // ← appended last, so it layers over the web app
  ] } }
}
```

If you see `dsh-relay declares no dsh.bundle`, the install didn't land properly. [Troubleshooting](TROUBLESHOOTING.md#dsh-relay-declares-no-dshbundle) explains the usual cause.

Want unreleased changes? You can install from GitHub. Pin a commit so a later push can't change what runs on your machine without you noticing:

```sh
npx @deepseek-ai/dsh plugin --profile web add github:sorsama/deepseek-harness-relay#<sha>
```

That route builds from source, so pnpm may ask you to allow a build script.

## Step 3: Restart the harness

A running harness keeps the plugins it started with, so stop it with Ctrl+C and start it again:

```sh
npx @deepseek-ai/dsh web
```

You should see the relay's lines before the usual harness URL:

```
[dsh-relay] listening on https://127.0.0.1:3443 https://10.0.1.20:3443 (harness on 127.0.0.1:3080)
[dsh-relay] no password set yet — open https://127.0.0.1:3443/relay/password on this machine to set one
dsh web: http://127.0.0.1:3080
```

The relay lists every address your machine has. If you use VirtualBox, WSL, or a VPN, their network adapters show up too. Pick the address on the same network as your phone; `ipconfig` (or `ip addr`) tells you which is which.

## Step 4: Set a password

On the machine running the harness, open `https://127.0.0.1:3443/relay/password`.

Your browser will warn you about the certificate. That's normal with the default self-signed certificate, so accept it for now. [Certificates](CONFIGURATION.md#certificates) explains how to make the warning go away.

Until a password is set, this page only opens from the harness machine, so nobody else on your network can get there first and claim the relay.

Choose a long password. Anyone who signs in can run commands on this computer, because that's what the agent does. The minimum is 10 characters, but treat that as a floor. You can change the password later from the same page, which is linked from `/relay/devices`.

You'll notice the relay never asks you to sign in on this machine. Whoever sits at this keyboard already has a shell, so a password here wouldn't protect anything, and `https://127.0.0.1:3443/` takes you straight to the harness. To see the sign-in page, open the relay from another device.

## Step 5: Pair your phone

1. On the harness machine, open `https://127.0.0.1:3443/relay/pair`.
2. Scan the QR code with your phone. Or open `https://<your-lan-ip>:3443/relay/pair` on the phone and type the 8-digit code.
3. Give the device a name.

Each code works once and expires after five minutes. Your paired devices are listed at `/relay/devices`, each with its own revoke button.

Your phone's browser can now open the full harness UI at `https://<your-lan-ip>:3443/`.

## Step 6: Set up the DSH Mobile app (optional)

### DSH Mobile 0.8.0 and later

Pair inside the app; there's nothing else to configure. Open **Relay → Pair a relay**, then scan the QR code from `/relay/pair`, or type the address and the 8-digit code. The app keeps a real token, uses HTTPS, and pins the relay's key.

Once every app you use is paired, turn off the compatibility bridge by adding this to the `relay` row's `config` (see [the config file](CONFIGURATION.md#the-config-file)):

```yaml
compat:
  addressGrants: false
```

Version 0.8.0 doesn't need it, and the bridge trusts network addresses, which isn't real authentication. [SECURITY.md](SECURITY.md#address-grants) explains why.

<details>
<summary>DSH Mobile 0.5.0 to 0.7.0</summary>

These versions can't send a credential (no `Authorization` header, no cookies, no `Origin`), and they can't connect to a self-signed HTTPS server. 0.7.0 added `https://`, but only for certificates signed by a trusted authority. They need a second, plain HTTP listener:

```sh
DSH_RELAY_PLAIN_PORT=3444 npx @deepseek-ai/dsh web
```

Then:

1. Pair from the phone's browser as in step 5, over `https://…:3443`.
2. In the app, connect to `<your-lan-ip>` on port `3444`.

Pairing from the browser records your phone's network address, and the app gets in because it connects from that same address.

That's weaker than a real credential, and the relay treats it that way. It only works on private addresses, lasts one day by default, disappears when you revoke the device, and never reaches the harness settings or credentials. It also stops working when your phone's address changes, for example when you switch between Wi-Fi and mobile data or the router renews its lease. When that happens, pair again.

Updating to 0.8.0 is the better fix.

</details>

## What's next

- **Relay settings** are at **Plugins → dsh-relay → Configure** on the harness machine. Pairing, devices, and the password live on the relay's own pages, which a small **Relay** link in the corner of the harness UI opens. See [Configuration](CONFIGURATION.md) for the full list of options.
- **The certificate warning** goes away once you give the relay a certificate your browser trusts. See [Certificates](CONFIGURATION.md#certificates).
- **Reaching the relay from outside your home network** takes a few extra precautions. See [Reaching the relay from the internet](CONFIGURATION.md#reaching-the-relay-from-the-internet).
- **Something not working?** See [Troubleshooting](TROUBLESHOOTING.md).

## Turning it off

To skip the relay for a single run, keep it installed and set `DSH_RELAY_DISABLE=1`:

```sh
DSH_RELAY_DISABLE=1 npx @deepseek-ai/dsh web
```

To remove it completely:

```sh
npx @deepseek-ai/dsh plugin --profile web remove dsh-relay
npx @deepseek-ai/dsh web
```

Removing the plugin leaves `~/.dsh/relay/` behind. Delete that folder to forget the password, every paired device, and the generated certificate.
