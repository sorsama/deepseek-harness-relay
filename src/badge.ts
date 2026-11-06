/**
 * A way back to the relay's own pages from inside the harness UI.
 *
 * The relay ships its operational pages on its own listener, so a person
 * looking at the chat had no way to reach pairing, the device list, or the
 * password form except by typing a path they had to already know.
 *
 * `ctx.webServer.tapIndex` is the seam: a pure html-to-html transform the SPA
 * server runs over every index response, the same mechanism the client module
 * system uses to inject its boot manifest.
 *
 * The href stays relative, which reads correctly through the relay and works
 * with no script at all. Served from the relay's own origin, `/relay/...` is
 * answered by the relay itself. Served from the harness's own loopback port it
 * falls through to the harness, which does not claim that prefix — the link is
 * then inert, and deliberately so: redirecting it to the relay's TLS origin
 * would send an embedding shell (the desktop app's Electron window) to a
 * self-signed certificate it cannot load, and a failed main-frame navigation
 * there is fatal. A dead link is the right failure; a broken application is
 * not. See the note in `src/index.ts` where the redirect used to live.
 * @module dsh-relay/badge
 */

/** Element id, also the guard against a double injection. */
const ELEMENT_ID = 'dsh-relay-link'

/** Where the link points. */
const TARGET_PATH = '/relay/devices'

/** The anchor and its stylesheet, injected before the closing body tag. */
const MARKUP = `<a id="${ELEMENT_ID}" href="${TARGET_PATH}" title="dsh-relay — pairing, devices, and password">
<svg width="14" height="14" viewBox="0 0 22 22" fill="none" aria-hidden="true"><circle cx="11" cy="11" r="2.4" fill="currentColor"/><path d="M6.6 6.6a6.2 6.2 0 0 0 0 8.8M15.4 6.6a6.2 6.2 0 0 1 0 8.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
<span>Relay</span></a>
<style>
#${ELEMENT_ID} {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 2147483000;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  border-radius: 14px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1));
  background: var(--dsw-alias-bg-layer-2, #fff);
  color: var(--dsw-alias-label-secondary, #61666b);
  font: 12px/18px var(--dsw-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
  text-decoration: none;
  box-shadow: var(--dsw-shadow-lv1, 0 2px 4px 0 rgba(0, 0, 0, 0.05));
  opacity: 0.75;
  transition: opacity 0.2s var(--ds-ease-in-out, cubic-bezier(0.4, 0, 0.2, 1)),
    background 0.2s var(--ds-ease-in-out, cubic-bezier(0.4, 0, 0.2, 1));
}
#${ELEMENT_ID}:hover, #${ELEMENT_ID}:focus-visible {
  opacity: 1;
  color: var(--dsw-alias-label-primary, #0f1115);
  background: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06));
}
@media (prefers-reduced-motion: reduce) { #${ELEMENT_ID} { transition: none; } }
</style>`

/**
 * Add the link to one index document.
 *
 * Applied to every index response, including each single-page-application
 * route fallback, so it is idempotent and never throws: it runs inside the
 * harness's own response path, where a failure would break the page rather
 * than just this link.
 * @param html - the index document as the frontend server rendered it.
 * @returns the document with the link before `</body>`, or unchanged when it
 * is already present or there is no body element to inject into.
 */
export function injectRelayLink(html: string): string {
  if (html.includes(ELEMENT_ID)) return html
  const close = html.lastIndexOf('</body>')
  if (close < 0) return html
  return `${html.slice(0, close)}${MARKUP}
${html.slice(close)}`
}
