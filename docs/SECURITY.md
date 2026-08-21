# Security

## The thing to understand first

The DeepSeek Harness is a coding agent. It runs shell commands, reads and writes files, and can install software — on the machine it is running on. **Anyone who authenticates to this relay can do all of that.** There is no lesser tier of access to grant: the harness's own maintainers make the same point when they refuse `--host 0.0.0.0` because it "would expose remote code execution to the network".

So the question this plugin answers is not "how do we restrict what a remote user can do" — it is "how do we make sure the remote user is you".

## What the relay defends against

**An unauthenticated stranger on your network.** The harness's `/api` fence checks the `Host` header for DNS rebinding and cross-site requests, and says outright that it "is not an auth layer". Without a credential, the relay answers 403 before a request reaches the harness at all.

**A rebound web page.** Proxying rewrites `Host` to the loopback authority, which is exactly what the harness's fence exists to detect — so the relay carries that fence itself, and applies it *before* the rewrite and before any credential is read. A page at `evil.example` that points a short-TTL DNS record at your relay still sends `Host: evil.example`, and the relay refuses it. This is why `trustedHosts` and `publicHostnames` matter: the relay only answers to the authorities it was told about.

**Credential replay after you notice.** Every device is individually revocable, and "sign out everywhere" rotates the signing key, which invalidates every cookie and every device token at once.

**Brute force.** Sign-ins and pairing attempts are counted per source address and locked out; every request is rate limited per address.

**Credentials at rest.** The password is a salted scrypt hash. Bearer tokens are stored only as keyed hashes — the token itself is shown once, at pairing, and never again. State and the private key are written mode `0600` into their own directory rather than into shared harness storage.

**A plugin you did not audit becoming reachable.** The harness's Connection carrier lets any plugin register an RPC channel of its own, and several are declared loopback-only. The `Host` rewrite would promote all of them. The relay refuses any write method addressed to a path it does not know about, so that promotion is limited to `/api` and anything the operator names in `extraProxyPaths`.

## What the relay does not defend against

**A weak password.** Ten characters is the enforced minimum; that is a floor, not a recommendation.

**Your own machine being compromised.** Loopback requests are treated as the operator, because on that machine the attacker already has what the relay protects.

**Plaintext, if you choose it.** `tls: off` and the plain compatibility listener send credentials and traffic in the clear. Anything on the network path can read them.

**A shared or spoofed source address.** See below.

## Address grants: read this before enabling them

DSH Mobile 0.5.0 hardcodes `http://` and sends no `Authorization` header, no cookies, and no `Origin`. There is no field in that client that can carry a credential. The only facts the relay can observe about it are the port it connected to and the address it came from.

So `compat.addressGrants` accepts requests from an address a paired device was last seen on. **A source address is not authentication.** Specifically:

- **NAT** — every device behind the same router shares one public address, and every subscriber behind carrier-grade NAT shares one too. The relay therefore refuses to grant a non-private address at all, which means grants do not work over a port-forwarded connection.
- **DHCP** — a lease expires and the granted `192.168.1.42` becomes a guest's laptop.
- **IPv6 privacy extensions** — Android rotates its temporary address, roughly daily, and the grant dies with it.
- **Network changes** — moving between Wi-Fi and cellular gets a new address and needs a new pairing.
- **Same-segment spoofing** — anything on the same Wi-Fi can ARP-spoof and source-spoof its way into a granted address.
- **Other apps on the same phone** — they share the address, and so share the grant.

The relay narrows this as far as it can: private ranges only, a TTL, revoked with the device that created it, and **never privileged** — an address-granted client cannot reach settings, credentials, model discovery, or the host directory pickers no matter how `privilegedMethods` is configured.

It is enabled by default only because the alternative available to that client today is the fully unauthenticated LAN patch, which is strictly worse. Set `compat.addressGrants: false` as soon as your client can hold a token.

## The privileged method set

The harness pins these to loopback, and the relay keeps its own copy of the list because the `Host` rewrite lifts the upstream pin:

```
agentPreset.read  agentPreset.copy  agentPreset.openDocument  agentPreset.remove
host.pickDirectory  host.openPath
settings.describe  settings.openDocument  settings.update  settings.replace  settings.mutate
credentials.describe  credentials.set  credentials.unset
llm.discoverModels
```

They are privileged for two reasons. The settings and credential domains mutate your configuration and secret store, and reading them is equally sensitive — `credentials.describe` reports whether an arbitrary environment variable is configured and where from. `llm.discoverModels` makes the host issue a request to a URL the caller chose and reports what came back, which is a probe for whatever your machine can reach and the client cannot.

`privilegedMethods: allow-authenticated` (the default) lets a password or device-token client reach them, on the reasoning that a real credential is what the upstream comment was waiting for. `loopback-only` keeps them on your machine. Address grants never reach them.

## Reporting a vulnerability

Report privately through **Report a vulnerability** on this repository's Security tab, or by email to **sor@zyphite.com**. Please do not open a public issue.

Include what an attacker can do, the steps to reproduce, the relay and harness versions, and how the client was connected.

The facts documented above — that authentication grants shell access, and that address grants are weak — are the design, not vulnerability reports. A way *around* the fence, the credential check, or the privileged-method gate is.
