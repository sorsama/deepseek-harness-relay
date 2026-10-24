# Security

## Start here

DeepSeek Harness is a coding agent. It runs shell commands, reads and writes files, and installs software on the machine it runs on. **Anyone who signs in to this relay can do all of that.** There's no smaller level of access to hand out. The harness's own maintainers say the same thing when they refuse `--host 0.0.0.0`, because it "would expose remote code execution to the network".

So the relay doesn't try to limit what a remote user can do. Its job is to make sure the remote user is you.

## What the relay protects against

### A stranger on your network

The harness checks the `Host` header on its `/api` routes to stop DNS rebinding and cross-site requests, but its own code says that check "is not an auth layer". The relay adds the missing sign-in. A browser signs in with the password and gets a signed `HttpOnly; SameSite=Strict` cookie, and an app pairs and gets a bearer token. A request without a valid credential gets a 403 and never reaches the harness.

### A malicious web page using DNS rebinding

When the relay forwards a request, it rewrites `Host` to the loopback address. That's exactly what the harness's `Host` check is built to catch, so the relay runs that check itself, before the rewrite and before it reads any credential.

Say a page at `evil.example` points a short-lived DNS record at your relay. The browser still sends `Host: evil.example`, and the relay refuses it. That's why `trustedHosts` and `publicHostnames` matter: the relay only answers to the names you've told it about.

### A reverse proxy on loopback letting the internet in as you

Tailscale Funnel, Tailscale Serve, nginx, and Caddy connect from `127.0.0.1`, and the relay normally asks loopback for nothing. So when a loopback request carries a forwarding header (`Forwarded`, `X-Forwarded-*`, `X-Real-IP`, or `Via`), the relay treats it as network traffic: it needs a credential and counts against the rate limit.

A forwarding header is a hint, though, and a proxy can strip it. A proxy that does looks exactly like your own browser. That's why the [configuration guide](CONFIGURATION.md#reverse-proxies) says to point any proxy at a non-loopback address.

### A stolen credential, once you notice

You can revoke each device on its own. "Sign out everywhere" rotates the signing key, which invalidates every browser session and every device token at once.

### Password guessing

Sign-in and pairing attempts are counted per source address, and too many failures lock that address out. Every request is also rate limited per address.

### Credentials stored on disk

The password is stored as a salted scrypt hash. Device tokens are stored only as keyed hashes; you see the token once, when you pair, and the relay never shows it again. The relay's state and private key are written with mode `0600` into their own folder, separate from the harness's shared storage. (On Windows, mode `0600` has no effect; see [Certificates](CONFIGURATION.md#certificates).)

### Other plugins you haven't reviewed

Any harness plugin can register its own RPC channel, and several of them are meant for loopback only. Because the relay rewrites `Host` to loopback, it could accidentally expose all of them. To prevent that, the relay refuses any write request to a path it doesn't know about. Only `/api` and whatever you list in `extraProxyPaths` get through.

## What the relay doesn't protect against

- **A weak password.** The minimum is 10 characters. Treat that as the lowest you can go, not a target.
- **A compromised harness machine.** The relay treats loopback as you, because anyone already on that machine has everything the relay protects.
- **Plain HTTP, if you turn it on.** `tls: off` and the plain compatibility listener send credentials and traffic unencrypted. Anything on the network path can read them.
- **A shared or spoofed network address.** See the next section.

## Address grants

DSH Mobile 0.7.0 and earlier send no `Authorization` header, no cookies, and no `Origin`. There's nowhere in those versions to put a credential, so the only things the relay can see about them are the port they connect to and the address they come from.

DSH Mobile 0.8.0 and later don't need address grants. They pair, keep a real token, and pin the relay's key. If all your apps are on 0.8.0, set `compat.addressGrants: false` and you can skip the rest of this section.

With `compat.addressGrants` on, the relay accepts requests from the address a paired device was last seen on. **A network address is not authentication.** Here's why:

- **NAT.** Every device behind the same router shares one public address, and with carrier-grade NAT, so do many other customers. The relay won't grant a public address at all, which means grants don't work over port forwarding.
- **DHCP.** A lease expires, and the trusted `192.168.1.42` becomes a guest's laptop.
- **IPv6 privacy addresses.** Android rotates its temporary address about once a day, and the grant goes with it.
- **Changing networks.** Switching between Wi-Fi and mobile data gives the phone a new address, so you have to pair again.
- **Spoofing.** Anything on the same Wi-Fi can use ARP and source spoofing to take over a trusted address.
- **Other apps on the same phone.** They share the phone's address, so they share the grant too.

The relay limits grants as much as it can. They only work for private addresses, they expire, they're removed when you revoke the device that created them, and they **never** reach privileged methods, whatever `privilegedMethods` is set to.

Grants are on by default only because the alternative for an older app is the LAN patch, which has no authentication at all and is strictly worse. Turn them off as soon as every app you use can hold a token.

Turning grants off doesn't turn off `compat.plainPort`. That listener accepts device tokens too, so a paired app that can't pin a certificate can still use it. The token travels unencrypted there. That's your call to make, the same as with `tls: off`.

## Privileged methods

Some harness API endpoints are more sensitive than the rest. The relay keeps them to the harness machine unless you allow otherwise:

- **Settings:** reading and changing the harness configuration.
- **Credentials:** reading and changing the secret store. Even reading is sensitive, since `credentials/describe` reports whether any environment variable is set and where it comes from.
- **Model discovery** (`llm/discoverModels`): makes the harness machine send a request to a URL the caller picks and report what came back. That lets a remote caller probe anything your machine can reach.
- **Host desktop and files:** the folder picker, creating folders, and opening a workspace path on the desktop.
- **Agent preset authoring:** reading, copying, and deleting the presets that decide which plugins a session runs.

The exact list is in [`src/privileged.ts`](../src/privileged.ts). It includes the names from both the current harness API and the older 0.1.1 one, so one relay build works against either.

Up to harness 0.1.1, the harness kept these endpoints to loopback itself, and the relay copied that list so its `Host` rewrite couldn't undo the restriction. Harness 0.1.2 removed that list: anyone with a session can now reach the whole API. The relay's list is now its own policy, and it's the only thing between a paired phone and your credential store.

`privilegedMethods: allow-authenticated` (the default) lets anyone signed in with a password or device token reach these endpoints. `loopback-only` keeps them on the harness machine. Devices let in by address grant never reach them.

## Reporting a vulnerability

Report it privately through **Report a vulnerability** on this repository's Security tab, or by email to **sor@zyphite.com**. Please don't open a public issue.

Include what an attacker could do, steps to reproduce, the relay and harness versions, and how the client was connected.

Two things described above are part of the design, not vulnerabilities: signing in gives shell-level access, and address grants are weak. A way around the `Host` check, the credential check, or the privileged-method restriction is a vulnerability, and we want to hear about it.
