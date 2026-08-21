/**
 * A way back to the relay's own pages from inside the harness UI.
 *
 * The relay ships no browser plugin, so it contributes nothing to the
 * harness's Settings page — and that left its pages undiscoverable: a person
 * signed in and looking at the chat had no way to reach pairing, the device
 * list, or the password form except by typing a path they had to already know.
 *
 * `ctx.webServer.tapIndex` is the seam for this. It takes a pure html-to-html
 * transform that the SPA server runs over every index response, which is the
 * same mechanism the client module system uses to inject its boot manifest.
 * One anchor and one stylesheet is the whole contribution: no script, no
 * bundle, nothing that can fail to load and take the application down with it.
 *
 * The markup deliberately uses the harness's own `--dsw-alias-*` tokens, with
 * literal fallbacks for the moment before the theme sheets land, so the link
 * belongs to whichever theme the person is using.
 * @module dsh-relay/badge
 */

/** Element id, also the guard against a double injection. */
const ELEMENT_ID = 'dsh-relay-link'

/** The mark and label, styled to sit quietly until it is wanted. */
const MARKUP = `<a id="${ELEMENT_ID}" href="/relay/devices" title="dsh-relay — pairing, devices, and password">
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
  opacity: 0.55;
  transition: opacity 0.2s var(--ds-ease-in-out, cubic-bezier(0.4, 0, 0.2, 1));
}
#${ELEMENT_ID}:hover, #${ELEMENT_ID}:focus-visible {
  opacity: 1;
  color: var(--dsw-alias-label-primary, #0f1115);
}
@media (prefers-reduced-motion: reduce) { #${ELEMENT_ID} { transition: none; } }
</style>`

/**
 * Add the link to one index document.
 *
 * Applied to every index response, including each single-page-application
 * route fallback, so it is written to be idempotent and never to throw: the
 * transform runs inside the harness's own response path, and a failure there
 * would break the page rather than just this link.
 * @param html - the index document as the frontend server rendered it.
 * @returns the document with the link before `</body>`, or unchanged when it
 * is already present or the document has no body element to inject into.
 */
export function injectRelayLink(html: string): string {
  if (html.includes(ELEMENT_ID)) return html
  const close = html.lastIndexOf('</body>')
  if (close < 0) return html
  return `${html.slice(0, close)}${MARKUP}\n${html.slice(close)}`
}
