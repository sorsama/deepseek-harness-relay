/**
 * The relay's command line.
 *
 * A surface bundle owns its own flag family: this plugin injects
 * `cmdlineArgs`, parses the invocation with its own commander program, and
 * publishes what it resolved as an ordinary Cordis service. The relay row
 * injects that service and reads it from `!!js` config expressions, so a flag
 * beats the value composed beside it.
 *
 * The program deliberately declines the help option and tolerates unknown
 * flags. The same argument snapshot is handed to every app plugin — the web
 * app parses `--host`, `--port`, `--trusted-host`, `--no-open` out of it — so
 * a program that rejected what it did not recognize would reject the surface's
 * own flags, and a second `--help` owner would print help twice.
 * @module dsh-relay/startup
 */

import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
// Activates the `cmdlineArgs` and `appExit` Context merge; erased at build time.
import type {} from '@deepseek-ai/dsh-cmdline'

/** Stable Cordis plugin name. */
export const name = 'relay-startup'

/** The launcher provides the command line before any tree entry mounts. */
export const inject = ['cmdlineArgs']

/** Service key the relay row injects to read these values. */
export const RELAY_STARTUP_SERVICE = 'relayStartup'

/** What the relay row reads from {@link RELAY_STARTUP_SERVICE}. */
export interface RelayStartupValues {
  /** Whether this invocation runs the relay at all. */
  enabled: boolean
  /** `--relay-bind`, absent when the invocation did not name one. */
  bind?: string
  /** `--relay-port`, absent when the invocation did not name one. */
  port?: number
  /** `--relay-plain-port`, absent when the invocation did not name one. */
  plainPort?: number
  /** `--relay-tls`, absent when the invocation did not name one. */
  tls?: string
  /** `--relay-hostname` entries, in argument order. */
  publicHostnames: string[]
}

/** The flag family, as commander parsed it. */
interface RelayOptions {
  relay: boolean
  relayBind?: string
  relayPort?: string
  relayPlainPort?: string
  relayTls?: string
  relayHostname?: string[]
}

/** Parse a flag that must name a port. */
function port(program: Command, flag: string, value: string): number {
  if (!/^\d+$/.test(value)) program.error(`error: ${flag} must be a number, got ${JSON.stringify(value)}`)
  const parsed = Number(value)
  if (parsed > 65535) program.error(`error: ${flag} must be at most 65535, got ${value}`)
  return parsed
}

/**
 * The relay's own program.
 * @returns a fresh program, so one process can parse more than once (tests).
 */
function relayCommand(): Command {
  return new Command()
    .name('dsh-relay')
    .helpOption(false)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .option('--no-relay', 'do not start the relay for this invocation')
    .option('--relay-bind <host>', 'relay listen address')
    .option('--relay-port <port>', 'relay listen port; 0 lets the OS pick one')
    .option('--relay-plain-port <port>', 'extra plain-HTTP listener for clients that cannot use TLS')
    .option('--relay-tls <mode>', 'self-signed | files | off')
    .option('--relay-hostname <authority...>', 'name this relay is reached by; repeatable')
}

/**
 * Parse the invocation and publish the result.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx: Context): void {
  const program = relayCommand()
  program.action(() => {
    const options = program.opts<RelayOptions>()
    if (options.relayTls !== undefined && !['self-signed', 'files', 'off'].includes(options.relayTls)) {
      program.error(`error: --relay-tls must be self-signed, files, or off, got ${JSON.stringify(options.relayTls)}`)
    }
    ctx.provide(RELAY_STARTUP_SERVICE, {
      enabled: options.relay,
      ...options.relayBind !== undefined && { bind: options.relayBind },
      ...options.relayPort !== undefined && { port: port(program, '--relay-port', options.relayPort) },
      ...options.relayPlainPort !== undefined && {
        plainPort: port(program, '--relay-plain-port', options.relayPlainPort),
      },
      ...options.relayTls !== undefined && { tls: options.relayTls },
      publicHostnames: options.relayHostname ?? [],
    } satisfies RelayStartupValues)
  })

  // A local reimplementation of `parseCmdline` from `@deepseek-ai/dsh-cmdline`:
  // the helper is twenty lines over two services this plugin already reaches
  // through `ctx`, and importing it would pin an out-of-tree package to one
  // harness release for no behaviour of its own.
  const args = ctx.get('cmdlineArgs')
  const exit = ctx.get('appExit')
  if (args === undefined || exit === undefined) {
    throw new Error('dsh-relay: the launcher must provide ctx.cmdlineArgs and ctx.appExit before the tree mounts')
  }
  program.exitOverride().configureOutput({
    writeOut: text => void process.stdout.write(text),
    writeErr: text => void process.stderr.write(text),
  })
  try {
    program.parse(args.get(), { from: 'user' })
  } catch (error) {
    // exitOverride turns a rejection into a CommanderError; commander has
    // already written the text through the output configured above.
    const code = (error as { exitCode?: unknown }).exitCode
    if (typeof code !== 'number') throw error
    exit(code)
  }
}
