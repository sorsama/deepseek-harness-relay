/**
 * Which address a pairing QR names, and how the picker labels it.
 *
 * The failure these pin is the one the operator hit: the pairing page was
 * opened on the machine itself, so the QR encoded `https://127.0.0.1:3443` —
 * an address no phone can reach. Scanning it worked, connecting could not.
 *
 * The label tests pin the second half: a raw URL is unreadable on a phone, so
 * the picker shows the adapter and the numeric address — and "Tailscale"
 * appears only when the address is verified to be Tailscale's, never just
 * because an adapter's name contains the word.
 */
import { describe, expect, it } from 'vitest'
import { isTailscaleAddress, pairingOriginOptions, pairingOrigins } from '../src/origins.ts'
import { pairingPayload } from '../src/auth/pairing.ts'

/** A typical Windows machine: a real adapter, a WSL switch, Tailscale, and a link-local device. */
const INTERFACES = {
  'vEthernet (WSL (Hyper-V firewall))': [{ address: '172.28.144.1', family: 'IPv4' }],
  'Ethernet': [{ address: '192.168.1.122', family: 'IPv4' }],
  'Tailscale': [
    { address: '100.121.55.94', family: 'IPv4' },
    { address: 'fd7a:115c:a1e0:ab12:4843:cd96:6273:5a9b', family: 'IPv6' },
  ],
  'Wi-Fi': [{ address: '2001:db8::5', family: 'IPv6' }],
  'Loopback Pseudo-Interface 1': [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  'Bluetooth Network Connection': [{ address: '169.254.7.67', family: 'IPv4' }],
}

/** The origins alone, in the order the picker offers them. */
function originsOf(interfaces: Parameters<typeof pairingOrigins>[0]): string[] {
  return pairingOrigins(interfaces, 'https', 3443).map(entry => entry.origin)
}

describe('ordering reachable origins', () => {
  it('puts the real adapter first and the link-local address last', () => {
    expect(originsOf(INTERFACES)).toEqual([
      'https://192.168.1.122:3443',
      'https://[2001:db8::5]:3443',
      'https://172.28.144.1:3443',
      'https://100.121.55.94:3443',
      'https://[fd7a:115c:a1e0:ab12:4843:cd96:6273:5a9b]:3443',
      'https://169.254.7.67:3443',
    ])
  })

  it('never offers loopback, which is the bug this exists for', () => {
    expect(originsOf(INTERFACES).some(origin => origin.includes('127.0.0.1'))).toBe(false)
  })

  it('uses the listener scheme and port', () => {
    expect(pairingOrigins({ Ethernet: [{ address: '192.168.1.122', family: 'IPv4' }] }, 'http', 8080)
      .map(entry => entry.origin))
      .toEqual(['http://192.168.1.122:8080'])
  })

  it('deduplicates and skips unusable entries', () => {
    const origins = pairingOrigins({
      A: [{ address: '192.168.1.2', family: 'IPv4' }, { address: '192.168.1.2', family: 'IPv4' }],
      B: [{ address: 'fe80::1', family: 'IPv6' }, { address: '', family: 'IPv4' }],
    }, 'https', 3443)
    expect(origins.map(entry => entry.origin)).toEqual(['https://192.168.1.2:3443'])
  })
})

describe('labelling addresses for the picker', () => {
  it('names the adapter and keeps only the numeric address', () => {
    const labels = pairingOrigins(INTERFACES, 'https', 3443).map(entry => entry.label)
    expect(labels).toEqual([
      'Ethernet — 192.168.1.122',
      'Wi-Fi — 2001:db8::5',
      'WSL — 172.28.144.1',
      'Tailscale — 100.121.55.94',
      'Tailscale — fd7a:115c:a1e0:ab12:4843:cd96:6273:5a9b',
      'Link-local — 169.254.7.67',
    ])
  })

  it('drops the URL spelling the scheme and port add nothing to', () => {
    const [entry] = pairingOrigins({ 'Wi-Fi': [{ address: '192.168.1.122', family: 'IPv4' }] }, 'https', 3443)
    expect(entry?.label).toBe('Wi-Fi — 192.168.1.122')
    expect(entry?.label).not.toContain('https://')
    expect(entry?.label).not.toContain(':3443')
  })
})

describe('verifying that an address really is Tailscale', () => {
  it('accepts a 100.64/10 address on an adapter named Tailscale', () => {
    expect(isTailscaleAddress('Tailscale', '100.121.55.94')).toBe(true)
    expect(isTailscaleAddress('Tailscale 1', '100.64.0.1')).toBe(true)
    expect(isTailscaleAddress('tailscale0', '100.127.255.254')).toBe(true)
  })

  it('accepts Tailscale\'s IPv6 ULA without needing the adapter name', () => {
    // macOS names Tailscale's adapter `utun3`, so the name proves nothing —
    // the fd7a:115c:a1e0::/48 prefix is Tailscale's alone.
    expect(isTailscaleAddress('utun3', 'fd7a:115c:a1e0::1')).toBe(true)
    expect(isTailscaleAddress('utun3', 'fd7a:115c:a1e0:ab12::5')).toBe(true)
  })

  it('refuses a Tailscale-sounding adapter whose address is outside Tailscale\'s ranges', () => {
    const [entry] = pairingOrigins({ Tailscale: [{ address: '192.168.1.5', family: 'IPv4' }] }, 'https', 3443)
    expect(entry?.tailscale).toBe(false)
    expect(entry?.label).toBe('Tailscale (unverified) — 192.168.1.5')
  })

  it('marks the link-local address a stopped Tailscale adapter keeps, without claiming it is Tailscale', () => {
    const [entry] = pairingOrigins({ Tailscale: [{ address: '169.254.5.46', family: 'IPv4' }] }, 'https', 3443)
    expect(entry?.tailscale).toBe(false)
    expect(entry?.label).toBe('Link-local (Tailscale) — 169.254.5.46')
  })

  it('refuses CGNAT on an unrelated adapter, which any carrier can hand out', () => {
    expect(isTailscaleAddress('eth0', '100.100.1.2')).toBe(false)
    const [entry] = pairingOrigins({ eth0: [{ address: '100.100.1.2', family: 'IPv4' }] }, 'https', 3443)
    expect(entry?.tailscale).toBe(false)
    expect(entry?.label).toBe('eth0 — 100.100.1.2')
  })

  it('verifies a CGNAT address when the same adapter also carries Tailscale\'s ULA', () => {
    expect(isTailscaleAddress('utun3', '100.100.1.2', true)).toBe(true)
    const entries = pairingOrigins({
      utun3: [
        { address: '100.100.1.2', family: 'IPv4' },
        { address: 'fd7a:115c:a1e0::2', family: 'IPv6' },
      ],
    }, 'https', 3443)
    expect(entries.map(entry => [entry.address, entry.tailscale])).toEqual([
      ['100.100.1.2', true],
      ['fd7a:115c:a1e0::2', true],
    ])
  })
})

describe('choosing what the pairing page offers', () => {
  const wifi = { address: '192.168.1.122', family: 'IPv4' as const }
  const vpn = { address: '10.0.0.4', family: 'IPv4' as const }

  it('drops the loopback origin in favour of the network ones', () => {
    const candidates = pairingOrigins({ 'Wi-Fi': [wifi], Ethernet: [vpn] }, 'https', 3443)
    expect(pairingOriginOptions('https://127.0.0.1:3443', candidates).map(entry => entry.origin))
      .toEqual(['https://192.168.1.122:3443', 'https://10.0.0.4:3443'])
  })

  it('keeps the origin the operator already reached the relay by in front, with its label', () => {
    const candidates = pairingOrigins({
      'Wi-Fi': [wifi],
      Tailscale: [{ address: '100.121.55.94', family: 'IPv4' }],
    }, 'https', 3443)
    const ordered = pairingOriginOptions('https://100.121.55.94:3443', candidates)
    expect(ordered.map(entry => entry.origin)).toEqual([
      'https://100.121.55.94:3443',
      'https://192.168.1.122:3443',
    ])
    expect(ordered[0]?.label).toBe('Tailscale — 100.121.55.94')
  })

  it('labels an origin that is not in the interface list as this address', () => {
    const [entry] = pairingOriginOptions('https://10.0.0.4:3443', [])
    expect(entry?.origin).toBe('https://10.0.0.4:3443')
    expect(entry?.label).toBe('This address — 10.0.0.4')
  })

  it('keeps loopback when there is no network address, so the page still renders', () => {
    const options = pairingOriginOptions('https://127.0.0.1:3443', [])
    expect(options.map(entry => entry.origin)).toEqual(['https://127.0.0.1:3443'])
  })

  it('does not offer one origin twice', () => {
    const candidates = pairingOrigins({ 'Wi-Fi': [wifi] }, 'https', 3443)
    const options = pairingOriginOptions('https://192.168.1.122:3443', candidates)
    expect(options).toHaveLength(1)
    expect(options[0]?.label).toBe('Wi-Fi — 192.168.1.122')
  })
})

describe('the QR payload', () => {
  const code = { code: '48213977', expiresAt: 1_755_500_000_000 }

  it('always names the selected origin in `url`, even when the list starts elsewhere', () => {
    const payload = pairingPayload({
      url: 'https://192.168.1.122:3443',
      urls: ['https://10.0.0.4:3443', 'https://192.168.1.122:3443'],
      code,
    })
    expect(payload.url).toBe('https://192.168.1.122:3443')
    expect(payload.urls).toEqual(['https://192.168.1.122:3443', 'https://10.0.0.4:3443'])
  })

  it('omits the alternate list when there is only one origin', () => {
    const payload = pairingPayload({ url: 'https://192.168.1.122:3443', urls: ['https://192.168.1.122:3443'], code })
    expect(payload.urls).toBeUndefined()
  })

  it('stays version 1 for clients that do not know `urls`', () => {
    const payload = pairingPayload({ url: 'https://a:3443', urls: ['https://b:3443'], code })
    expect(payload.v).toBe(1)
    expect(payload.kind).toBe('dsh-relay-pair')
  })
})
