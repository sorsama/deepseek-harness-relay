/**
 * The HTML shell the relay's own pages render into.
 *
 * The mark here is this project's own. The harness's brand guidelines ask
 * third-party projects not to present official brand art in a way that reads
 * as endorsement, and to name themselves with the `DSH` abbreviation rather
 * than the full trademark — so these pages carry a relay glyph and the words
 * "DSH RELAY", never the official wordmark.
 * @module dsh-relay/pages/layout
 */

import { THEME_BOOT_JS, THEME_CSS } from './theme.ts'

/**
 * Escape a value for interpolation into HTML text or a quoted attribute.
 * @param value - the untrusted string.
 * @returns the escaped string.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * This project's own mark: a relay glyph, drawn in `currentColor` so it takes
 * the brand ink of whichever theme is active, the way the harness's own marks
 * do.
 */
const MARK = `<svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
  <circle cx="11" cy="11" r="2.4" fill="currentColor"/>
  <path d="M6.6 6.6a6.2 6.2 0 0 0 0 8.8M15.4 6.6a6.2 6.2 0 0 1 0 8.8"
        stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
  <path d="M3.6 3.6a10.4 10.4 0 0 0 0 14.8M18.4 3.6a10.4 10.4 0 0 1 0 14.8"
        stroke="currentColor" stroke-width="1.6" stroke-linecap="round" opacity="0.4"/>
</svg>`

/**
 * Render one complete page.
 * @param options.title - the document title.
 * @param options.body - already-escaped markup for the card's contents.
 * @param options.wide - render the wider card used by the admin page.
 * @returns the full HTML document.
 */
export function page(options: { title: string, body: string, wide?: boolean }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(options.title)}</title>
<style>${THEME_CSS}</style>
</head>
<body>
<script>${THEME_BOOT_JS}</script>
<main class="card${options.wide === true ? ' wide' : ''}">
  <div class="brand">${MARK}<span class="wordmark">DSH RELAY</span></div>
  ${options.body}
</main>
</body>
</html>
`
}
