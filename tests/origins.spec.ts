/**
 * Which address a pairing QR names.
 *
 * The failure these pin is the one the operator hit: the pairing page was
 * opened on the machine itself, so the QR encoded `https://127.0.0.1:3443` —
 * an address no phone can reach. Scanning it worked, connecting could not.
 */
import { describe, expect, it } from 'vitest'
import { isLoopbackOrigin, pairingOriginOptions, pairingOrigins } from '../src/origins.ts'
import { pairingPayload } from '../src/auth/pairing.ts'

/** A typical Windows machine: a real adapter, a WSL switch, a VPN, and a link-local device. */
const INTERFACES = {
  'vEthernet (WSL (Hyper-V firewall))': [{ address: '172.28.144.1', family: 'IPv4' }],
  'Ethernet': [{ address: '192.168.1.122', family: 'IPv4' }],
  'Tailscale': [{ address: '100.121.55.94', family: 'IPv4' }],
  'Wi-Fi': [{ address: '2001:db8::5', family: 'IPv6' }],
  'Loopback Pseudo-Interface 1': [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  'Bluetooth Network Connection': [{ address: '169.254.7.67', family: 'IPv4' }],
}

describe('ordering reachable origins', () => {
  it('puts the real adapter first and the link-local address last', () => {
    expect(pairingOrigins(INTERFACES, 'https', 3443)).toEqual([
      'https://192.168.1.122:3443',
      'https://[2001:db8::5]:3443',
      'https://172.28.144.1:3443',
      'https://100.121.55.94:3443',
      'https://169.254.7.67:3443',
    ])
  })

  it('never offers loopback, which is the bug this exists for', () => {
    expect(pairingOrigins(INTERFACES, 'https', 3443).some(origin => origin.includes('127.0.0.1'))).toBe(false)
  })

  it('uses the listener scheme and port', () => {
    expect(pairingOrigins({ Ethernet: [{ address: '192.168.1.122', family: 'IPv4' }] }, 'http', 8080))
      .toEqual(['http://192.168.1.122:8080'])
  })

  it('deduplicates and skips unusable entries', () => {
    const origins = pairingOrigins({
      A: [{ address: '192.168.1.2', family: 'IPv4' }, { address: '192.168.1.2', family: 'IPv4' }],
      B: [{ address: 'fe80::1', family: 'IPv6' }, { address: '', family: 'IPv4' }],
    }, 'https', 3443)
    expect(origins).toEqual(['https://192.168.1.2:3443'])
  })
})

describe('choosing what the pairing page offers', () => {
  it('drops the loopback origin in favour of the network ones', () => {
    expect(pairingOriginOptions('https://127.0.0.1:3443', ['https://192.168.1.122:3443']))
      .toEqual(['https://192.168.1.122:3443'])
  })

  it('keeps the origin the operator already reached the relay by in front', () => {
    expect(pairingOriginOptions('https://192.168.1.122:3443', ['https://192.168.1.122:3443', 'https://10.0.0.4:3443']))
      .toEqual(['https://192.168.1.122:3443', 'https://10.0.0.4:3443'])
  })

  it('keeps loopback when there is no network address, so the page still renders', () => {
    expect(pairingOriginOptions('https://127.0.0.1:3443', [])).toEqual(['https://127.0.0.1:3443'])
  })

  it('recognises loopback names without mistaking a LAN address for one', () => {
    expect(isLoopbackOrigin('https://127.0.0.1:3443')).toBe(true)
    expect(isLoopbackOrigin('https://localhost:3443')).toBe(true)
    expect(isLoopbackOrigin('https://[::1]:3443')).toBe(true)
    expect(isLoopbackOrigin('https://192.168.1.122:3443')).toBe(false)
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
