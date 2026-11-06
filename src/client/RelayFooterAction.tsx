/**
 * The **Relay** action at the sidebar foot, beside the account menu.
 *
 * The account popover (Settings / Feedback / Sign out) is the natural home for
 * this entry, but the harness does not offer a seat there: those rows are
 * rendered by `@deepseek-ai/dsh-client-ui-settings-account` from a hardcoded
 * list, and 0.2.1 declares no list slot for one more. Its single
 * `settings.launcher` seat is the whole launcher, and claiming it would mean
 * reimplementing the account menu — sign-out, profile, notices, dialogs — on
 * behalf of a package this plugin does not own.
 *
 * `sidebar.footer.action` is the supported seat in the same corner: a list at
 * the sidebar foot, rendered directly above the account launcher, so the relay
 * is one click away from the popover without duplicating it. Like every other
 * page of the harness, it changes in place: the host half serves the relay's
 * pages on the harness origin too, which is what lets the desktop window show
 * them inside the app instead of opening a browser.
 * @module dsh-relay/client/RelayFooterAction
 */

import css from './RelayFooterAction.module.css'

/** What the sidebar footer seat supplies, plus the action's injected opener. */
export interface RelayFooterActionProps {
  /** Whether the sidebar renders wide content (false = the 56px rail). */
  readonly wide: boolean
  /** Change the page to the relay's own. Injected by `apply`. */
  readonly open: () => void
}

/** Accessible name; also the rail's only label, which is icon-only. */
const LABEL = 'Relay — pairing, devices, and password'

/**
 * One sidebar footer button for the relay.
 * @param props - sidebar width state and the injected opener.
 * @returns the button.
 */
export function RelayFooterAction({ wide, open }: RelayFooterActionProps) {
  return (
    <button
      type="button"
      className={wide ? css.action : `${css.action} ${css.rail}`}
      aria-label={LABEL}
      title={LABEL}
      onClick={() => { open() }}
    >
      <svg width={wide ? 16 : 18} height={wide ? 16 : 18} viewBox="0 0 22 22" fill="none" aria-hidden="true">
        <circle cx="11" cy="11" r="2.4" fill="currentColor" />
        <path
          d="M6.6 6.6a6.2 6.2 0 0 0 0 8.8M15.4 6.6a6.2 6.2 0 0 1 0 8.8"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
      {wide && <span className={css.label}>Relay</span>}
    </button>
  )
}
