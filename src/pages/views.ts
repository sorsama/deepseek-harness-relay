/**
 * The relay's page bodies.
 *
 * Every interaction is a plain form POST. No script runs on these pages beyond
 * the theme bootstrap, which means they work on a phone browser with scripting
 * restricted, they cannot leak a credential through an XHR that outlives the
 * page, and there is nothing to bundle. Cross-site form posts are refused by
 * the fence and the session cookie is `SameSite=Strict`, so the forms need no
 * separate token.
 *
 * Navigation is a control, not a line of prose. A page's ways onward are
 * buttons in an action row — `.btn` gives an anchor the same capsule the
 * harness's Button primitive gives a `button`, so a person reads one weight
 * and one hit target whether the action posts a form or follows a link.
 * @module dsh-relay/pages/views
 */

import type { PairingAddress } from '../origins.ts'
import type { DeviceRecord, PeerRecord } from '../state.ts'
import { escapeHtml, page } from './layout.ts'

/** Hex digits of a device id shown next to its name. */
const DEVICE_ID_SUFFIX = 4

/**
 * The tail of a device id, for telling two rows of the same name apart.
 *
 * The name is deliberately the phone's own model — that is what a person
 * recognises when deciding what to revoke — so two pairings from one handset
 * produce two rows that read identically until the address or the last-seen
 * time differs. The suffix is not a credential and is not accepted as one: the
 * row's revoke form still carries the whole id.
 * @param id - the device id.
 * @returns the last few characters of the id.
 */
function shortId(id: string): string {
  return id.slice(-DEVICE_ID_SUFFIX)
}

/** Render a relative timestamp the way a device list wants it. */
function since(timestamp: number | undefined, now: number): string {
  if (timestamp === undefined) return 'never'
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${String(minutes)} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${String(hours)} h ago`
  return `${String(Math.round(hours / 24))} d ago`
}

/**
 * The sign-in page.
 * @param options.error - message to show above the form.
 * @param options.next - path to return to after a successful sign-in.
 * @returns the full HTML document.
 */
export function loginPage(options: {
  readonly error?: string | undefined
  readonly next: string
}): string {
  const notice = options.error === undefined
    ? ''
    : `<div class="notice error">${escapeHtml(options.error)}</div>`
  return page({
    title: 'Sign in',
    body: `
  <h1>Sign in</h1>
  <p>This relay fronts a DeepSeek Harness on this machine.</p>
  ${notice}
  <form method="post" action="/relay/login">
    <input type="hidden" name="next" value="${escapeHtml(options.next)}">
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
    <button class="primary" type="submit">Sign in</button>
  </form>`,
  })
}

/**
 * The page that sets a password, or replaces the one already set.
 *
 * This is deliberately separate from the sign-in page. A request from the
 * machine running the harness is already the operator — asking it for a
 * password would be theatre, since whoever is there has a shell — so the
 * sign-in page redirects it straight through. That left first-run setup with
 * nowhere to happen, which is what this page is for.
 * @param options.hasPassword - whether a password already exists.
 * @param options.error - message to show above the form.
 * @param options.next - path to return to afterwards.
 * @returns the full HTML document.
 */
export function passwordPage(options: {
  readonly hasPassword: boolean
  readonly error?: string | undefined
  readonly next: string
}): string {
  const notice = options.error === undefined
    ? ''
    : `<div class="notice error">${escapeHtml(options.error)}</div>`
  const heading = options.hasPassword ? 'Change the password' : 'Set a password'
  const lead = options.hasPassword
    ? 'Replacing it does not sign anyone out. Use <a href="/relay/devices">sign out everywhere</a> on the '
      + 'devices page for that.'
    : 'Nobody can sign in from the network until you set one. Anyone who does can run commands on this machine, because that is what the agent does.'
  return page({
    title: heading,
    body: `
  <h1>${escapeHtml(heading)}</h1>
  <p>${lead}</p>
  ${notice}
  <form method="post" action="/relay/password">
    <input type="hidden" name="next" value="${escapeHtml(options.next)}">
    <label for="password">${options.hasPassword ? 'New password' : 'Password'}</label>
    <input id="password" name="password" type="password" autocomplete="new-password" required minlength="10" autofocus>
    <label for="confirm">Confirm</label>
    <input id="confirm" name="confirm" type="password" autocomplete="new-password" required minlength="10">
    <button class="primary" type="submit">${options.hasPassword ? 'Replace password' : 'Set password'}</button>
  </form>
  <p class="caption">At least 10 characters. Only reachable from the machine running the harness${
    options.hasPassword ? ', or with an existing session' : ''}.</p>`,
  })
}

/**
 * The operator's pairing page: the QR, the code, and what a device does with them.
 * @param options - the live invitation and the origins it points at.
 * @returns the full HTML document.
 */
export function pairPage(options: {
  readonly qrSvg: string
  readonly code: string
  readonly expiresInSeconds: number
  readonly url: string
  /** Every network origin a phone could use, default first; absent when there is only one. */
  readonly origins?: readonly PairingAddress[] | undefined
  /** Whether the QR had to fall back to loopback because no network address was found. */
  readonly loopbackOnly?: boolean | undefined
  readonly plainUrl?: string | undefined
  readonly fingerprint?: string | undefined
}): string {
  const plain = options.plainUrl === undefined
    ? ''
    : `<div class="notice tip">DSH Mobile 0.5.0 cannot use TLS, so it connects over the plain listener instead:
       <br><span class="mono">${escapeHtml(options.plainUrl)}</span></div>`
  const pin = options.fingerprint === undefined
    ? `<div class="notice warn">This relay is serving plaintext. Anything on the network path can read the traffic.</div>`
    : `<p class="caption fingerprint">Certificate pin (SHA-256/SPKI)<br><span class="mono">${escapeHtml(options.fingerprint)}</span></p>`
  // The machine usually has more than one network address, and only the
  // operator knows which network the phone is on. Without this the QR names
  // whichever one the heuristic guessed first.
  //
  // Each option reads as `<adapter> — <numeric address>` instead of a full
  // URL: the scheme and port are the same for every choice, and a raw IPv6 URL
  // is close to unreadable on a phone. A Tailscale-like adapter is called
  // Tailscale only when `origins.ts` verified the address belongs to Tailscale.
  const picker = options.origins === undefined
    ? ''
    : `<form method="get" action="/relay/pair" class="origins">
    <label for="origin">Address your device can reach</label>
    <select id="origin" name="origin">
      ${options.origins.map(entry => `<option value="${escapeHtml(entry.origin)}"${entry.origin === options.url ? ' selected' : ''}>${escapeHtml(entry.label)}</option>`).join('\n      ')}
    </select>
    <button class="outline" type="submit">Show this address</button>
  </form>
  <p class="caption">Labels name the adapter and its numeric IP. <strong>Tailscale</strong> is shown only for
     addresses verified to be Tailscale's own.</p>`
  const noNetwork = options.loopbackOnly !== true
    ? ''
    : `<div class="notice warn">No network address was found, so this QR points at loopback and no other
       device can reach it. Connect this machine to the network your device is on, then reload this page — or
       open the relay's address on the device and type the code by hand.</div>`

  return page({
    wide: true,
    title: 'Pair a device',
    body: `
  <h1>Pair a device</h1>
  <p>Scan this with the DSH Mobile app, or open <span class="mono">${escapeHtml(options.url)}/relay/pair</span> on the device and type the code.</p>
  <div class="qr">${options.qrSvg}</div>
  ${picker}
  ${noNetwork}
  <div class="code">${escapeHtml(options.code)}</div>
  <p class="caption">Expires in ${String(options.expiresInSeconds)} seconds, and works once.</p>
  ${plain}
  ${pin}
  <div class="actions">
    <form method="post" action="/relay/pair/new">
      <button class="outline" type="submit">New code</button>
    </form>
    <a class="btn outline" href="/relay/devices">Paired devices</a>
    <a class="btn outline" href="/relay/computers">Computers</a>
  </div>
  <div class="actions">
    <a class="btn ghost" href="/">Back to the harness</a>
  </div>`,
  })
}

/**
 * The device-facing enrolment form.
 * @param options.error - message to show above the form.
 * @param options.code - a code carried in the URL, prefilled.
 * @returns the full HTML document.
 */
export function claimPage(options: { readonly error?: string | undefined, readonly code?: string | undefined }): string {
  const notice = options.error === undefined
    ? ''
    : `<div class="notice error">${escapeHtml(options.error)}</div>`
  return page({
    title: 'Pair this device',
    body: `
  <h1>Pair this device</h1>
  <p>Enter the code shown on the machine running the harness.</p>
  ${notice}
  <form method="post" action="/relay/pair">
    <label for="code">Pairing code</label>
    <input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code"
           required value="${escapeHtml(options.code ?? '')}" ${options.code === undefined ? 'autofocus' : ''}>
    <label for="name">Device name</label>
    <input id="name" name="name" type="text" required maxlength="64" placeholder="Pixel 8"
           ${options.code === undefined ? '' : 'autofocus'}>
    <button class="primary" type="submit">Pair</button>
  </form>`,
  })
}

/**
 * Confirmation after a device enrols, carrying the token exactly once.
 * @param options - the minted credential and the addresses it works from.
 * @returns the full HTML document.
 */
export function pairedPage(options: {
  readonly deviceName: string
  readonly token: string
  readonly granted: boolean
  readonly plainUrl?: string | undefined
}): string {
  const grant = options.granted
    ? `<div class="notice tip">This device's network address is now accepted for a limited time, so DSH Mobile 0.5.0 —
       which cannot send a credential of its own — can connect. It is not a substitute for the token: it stops working
       when the address changes, and it never reaches the harness settings or credentials.</div>`
    : ''
  const plain = options.plainUrl === undefined
    ? ''
    : `<p class="caption">In DSH Mobile, connect to <span class="mono">${escapeHtml(options.plainUrl)}</span>.</p>`
  return page({
    wide: true,
    title: 'Device paired',
    body: `
  <h1>Paired</h1>
  <p><strong>${escapeHtml(options.deviceName)}</strong> is enrolled. Its token is shown once and never again — a client
     that supports it sends this as <span class="mono">Authorization: Bearer &lt;token&gt;</span>.</p>
  <div class="notice tip mono" style="word-break: break-all">${escapeHtml(options.token)}</div>
  ${grant}
  ${plain}
  <div class="actions">
    <a class="btn primary" href="/">Open the harness</a>
    <a class="btn outline" href="/relay/devices">Paired devices</a>
  </div>`,
  })
}

/**
 * The device list, with revocation.
 * @param options - the enrolled devices and the relay's current posture.
 * @returns the full HTML document.
 */
export function devicesPage(options: {
  readonly devices: readonly DeviceRecord[]
  readonly now: number
  readonly tlsMode: string
  readonly hasPassword: boolean
  readonly fingerprint?: string | undefined
  readonly url: string
  readonly plainUrl?: string | undefined
}): string {
  const rows = options.devices.length === 0
    ? '<p class="caption">Nothing paired yet.</p>'
    : options.devices.map(device => `
    <div class="row">
      <div class="meta">
        <span class="name">${escapeHtml(device.name)} <span class="mono">${escapeHtml(shortId(device.id))}</span></span>
        <span class="sub">paired ${escapeHtml(since(device.createdAt, options.now))} &middot; last seen ${
          escapeHtml(since(device.lastSeenAt, options.now))}${
          device.lastAddress === undefined ? '' : ` &middot; ${escapeHtml(device.lastAddress)}`}</span>
      </div>
      <div class="end">
        <span class="dot ${device.lastSeenAt === undefined ? 'off' : 'ok'}"></span>
        <form method="post" action="/relay/devices/revoke">
          <input type="hidden" name="deviceId" value="${escapeHtml(device.id)}">
          <button class="outline sm" type="submit">Revoke</button>
        </form>
      </div>
    </div>`).join('')

  const pin = options.fingerprint === undefined
    ? ''
    : `<p class="caption fingerprint">Pin <span class="mono">${escapeHtml(options.fingerprint)}</span></p>`
  const plain = options.plainUrl === undefined
    ? ''
    : `<div class="row"><div class="meta"><span class="name">Plain listener</span>
       <span class="sub">${escapeHtml(options.plainUrl)} &middot; compatibility clients only</span></div>
       <span class="dot ok"></span></div>`

  return page({
    wide: true,
    title: 'Paired devices',
    body: `
  <h1>Paired devices</h1>
  <div class="rows">
    <div class="row">
      <div class="meta">
        <span class="name">Relay</span>
        <span class="sub">${escapeHtml(options.url)} &middot; TLS ${escapeHtml(options.tlsMode)}</span>
      </div>
      <span class="dot ok"></span>
    </div>
    ${plain}
  </div>
  ${pin}
  <div class="rows">${rows}</div>
  <div class="row">
    <div class="meta">
      <span class="name">Password sign-in</span>
      <span class="sub">${options.hasPassword ? 'set' : 'not set — nobody can sign in from the network'}</span>
    </div>
    <span class="dot ${options.hasPassword ? 'ok' : 'off'}"></span>
  </div>
  <div class="actions">
    <form method="post" action="/relay/pair/new">
      <button class="primary" type="submit">Pair a new device</button>
    </form>
    <a class="btn outline" href="/relay/computers">Computers</a>
  </div>
  <div class="actions">
    <a class="btn outline" href="/relay/password">${options.hasPassword ? 'Change the password' : 'Set a password'}</a>
    <form method="post" action="/relay/signout-everywhere">
      <button class="outline" type="submit">Sign out everywhere</button>
    </form>
  </div>
  <p class="caption">Signing out everywhere rotates the signing key: every paired device and every browser session stops working at once.</p>
  <div class="actions">
    <a class="btn ghost" href="/">Back to the harness</a>
  </div>`,
  })
}

/**
 * The computers page: this PC's shared state, the form that links another PC,
 * and the linked computers with their last observed reachability.
 *
 * Linking is a two-step act on two machines: the other PC shows a pairing code
 * and its address, and this page takes them. The reverse record is written by
 * the other relay when it accepts the code, which is what makes the pair show
 * on both sides without a second visit.
 * @param options - this PC's posture and its live links.
 * @returns the full HTML document.
 */
export function computersPage(options: {
  readonly name: string
  readonly now: number
  readonly origins: readonly PairingAddress[]
  readonly fingerprint?: string | undefined
  readonly tlsMode: string
  readonly hasPassword: boolean
  readonly deviceCount: number
  readonly peers: readonly { readonly peer: PeerRecord, readonly online: boolean }[]
  readonly enabled: boolean
  /** Whether this page can navigate to a peer, which needs the relay's own TLS origin. */
  readonly navigable: boolean
  readonly error?: string | undefined
  readonly linked?: boolean | undefined
  readonly unlinked?: boolean | undefined
}): string {
  const notices = [
    options.error === undefined ? '' : `<div class="notice error">${escapeHtml(options.error)}</div>`,
    options.linked === true ? '<div class="notice tip">Linked. The other computer records this one too, so both lists show the pair.</div>' : '',
    options.unlinked === true ? '<div class="notice tip">Unlinked. The other computer sees the link stop working on its next call.</div>' : '',
    options.navigable
      ? ''
      : '<div class="notice warn">Open a linked computer from a browser at this PC\'s own relay address, not from the harness window: the window cannot load another computer\'s self-signed certificate, and a failed navigation there takes the app down. Linking itself works here.</div>',
    options.enabled && options.fingerprint !== undefined && options.origins.length === 0
      ? '<div class="notice warn">No network address was found, so this PC has no handoff address to offer the other computer. Connect this PC to the network the other computer is on, then reload this page.</div>'
      : '',
    options.enabled
      ? ''
      : '<div class="notice warn">Linking computers is turned off in this relay\'s settings. Turn on <strong>Link with other computers</strong> under Plugins → dsh-relay → Configure.</div>',
  ].join('\n  ')

  const addresses = options.origins.length === 0
    ? '<span class="sub">No network address was found.</span>'
    : options.origins.map(entry => `<span class="sub mono">${escapeHtml(entry.origin)}</span> <span class="sub">${escapeHtml(entry.label)}</span>`).join('<br>')

  const pin = options.fingerprint === undefined
    ? '<div class="notice warn">This relay is serving plaintext. Linking another PC needs TLS on both sides, so it cannot start here.</div>'
    : `<p class="caption fingerprint">Certificate pin (SHA-256/SPKI)<br><span class="mono">${escapeHtml(options.fingerprint)}</span></p>`

  const originOptions = options.origins
    .map(entry => `<option value="${escapeHtml(entry.origin)}">${escapeHtml(entry.label)}</option>`)
    .join('\n        ')

  const connectForm = options.enabled && options.origins.length > 0 && options.fingerprint !== undefined
    ? `<h2>Connect to another PC</h2>
  <p>On the other PC, open its <strong>Pair a device</strong> page. It shows the code and pin this form asks for.</p>
  <form method="post" action="/relay/computers/connect">
    <label for="selfUrl">This PC's address the other PC will use</label>
    <select id="selfUrl" name="selfUrl" autocomplete="off">
        ${originOptions}
    </select>
    <label for="url">The other PC's relay address</label>
    <input id="url" name="url" type="url" inputmode="url" required placeholder="https://192.168.1.10:3443">
    <label for="code">Pairing code</label>
    <input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" required>
    <label for="pin">Certificate pin (optional)</label>
    <input id="pin" name="pin" type="text" autocomplete="off" placeholder="The other PC's pairing page shows it">
    <button class="primary" type="submit">Connect</button>
  </form>
  <p class="caption">The pin is optional but recommended: it proves the certificate before the code is spent. Without it, the first certificate seen is recorded and checked on every later call.</p>`
    : ''

  const linked = options.peers.length === 0
    ? '<p class="caption">No computers linked yet.</p>'
    : options.peers.map(({ peer, online }) => `
    <div class="row">
      <div class="meta">
        <span class="name">${escapeHtml(peer.name)} <span class="mono">${escapeHtml(peer.linkId.slice(-4))}</span></span>
        <span class="sub mono">${escapeHtml(peer.url)}</span>
        <span class="sub">${online ? 'reachable' : 'not answering'} &middot; last seen ${
          escapeHtml(since(peer.lastSeenAt, options.now))}</span>
      </div>
      <div class="end">
        <span class="dot ${online ? 'ok' : 'off'}"></span>
        ${online && options.navigable
          ? `<form method="post" action="/relay/computers/open">
          <input type="hidden" name="peerId" value="${escapeHtml(peer.id)}">
          <button class="primary sm" type="submit">Open</button>
        </form>`
          : '<button class="primary sm" type="button" disabled>Open</button>'}
        <form method="post" action="/relay/computers/unlink">
          <input type="hidden" name="peerId" value="${escapeHtml(peer.id)}">
          <button class="outline sm" type="submit">Unlink</button>
        </form>
      </div>
    </div>`).join('')

  return page({
    wide: true,
    title: 'Computers',
    body: `
  <h1>Computers</h1>
  <p>This PC shares its harness through this relay. Linking another PC lets this browser open that PC's harness in one click, and lets its operator open this one.</p>
  ${notices}
  <div class="rows">
    <div class="row">
      <div class="meta">
        <span class="name">${escapeHtml(options.name)}</span>
        <span class="sub">this computer &middot; TLS ${escapeHtml(options.tlsMode)}</span>
      </div>
      <span class="dot ok"></span>
    </div>
    <div class="row">
      <div class="meta">
        <span class="name">Reachable at</span>
        ${addresses}
      </div>
    </div>
    <div class="row">
      <div class="meta">
        <span class="name">Password sign-in</span>
        <span class="sub">${options.hasPassword ? 'set' : 'not set — nobody can sign in from the network'}</span>
      </div>
      <span class="dot ${options.hasPassword ? 'ok' : 'off'}"></span>
    </div>
    <div class="row">
      <div class="meta">
        <span class="name">Paired devices</span>
        <span class="sub">${String(options.deviceCount)} ${options.deviceCount === 1 ? 'device' : 'devices'}</span>
      </div>
      <a class="btn outline sm" href="/relay/devices">Manage</a>
    </div>
  </div>
  ${pin}
  ${connectForm}
  <h2>Linked computers</h2>
  <div class="rows">${linked}</div>
  <div class="actions">
    <a class="btn outline" href="/relay/pair">Pair a device</a>
    <a class="btn outline" href="/relay/password">${options.hasPassword ? 'Change the password' : 'Set a password'}</a>
  </div>
  <div class="actions">
    <a class="btn ghost" href="/">Back to the harness</a>
  </div>
  <p class="caption">Opening a linked computer leaves this relay and shows its harness on its own address; the browser may warn once about its self-signed certificate. Unlinking on either computer ends the pair's calls.</p>`,
  })
}

/**
 * The last step of the open handoff: the session cookie is already set, and a
 * same-origin refresh carries it to the harness. A cross-site redirect would
 * not, because the cookie is SameSite=Strict.
 * @param peerName - the computer that was opened.
 * @returns the full HTML document.
 */
export function handoffPage(peerName: string): string {
  return page({
    title: 'Opening',
    refresh: '/',
    body: `
  <h1>Opening ${escapeHtml(peerName)}</h1>
  <p>Signed in to the other computer's relay. If the page does not move on its own, use the button below.</p>
  <div class="actions">
    <a class="btn primary" href="/">Open the harness</a>
  </div>
  <p class="caption">This handoff link works once. Opening it again asks for a new one.</p>`,
  })
}

/**
 * A standalone message, used for errors and confirmations.
 * @param options.title - the heading and document title.
 * @param options.message - body copy.
 * @param options.kind - which notice styling to use.
 * @returns the full HTML document.
 */
export function messagePage(options: {
  readonly title: string
  readonly message: string
  readonly kind?: 'error' | 'warn' | 'tip'
}): string {
  return page({
    title: options.title,
    body: `
  <h1>${escapeHtml(options.title)}</h1>
  <div class="notice ${options.kind ?? 'tip'}">${escapeHtml(options.message)}</div>
  <div class="actions">
    <a class="btn outline" href="/">Back</a>
  </div>`,
  })
}
