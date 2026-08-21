/**
 * The visual system the relay's own pages render in.
 *
 * These pages are served before the harness web application exists — a sign-in
 * form cannot be a plugin inside the app it gates — so they cannot consume the
 * harness's React primitives or its theme package. They reproduce the look
 * instead: the same semantic `--dsw-alias-*` token names over the same values,
 * the same system font stacks, and the same `body[data-ds-dark-theme]`
 * switching the harness itself uses, so a person moving between the sign-in
 * page and the application does not cross a visual seam.
 *
 * Only the tokens these pages actually use are reproduced. The upstream sheets
 * are the authority for everything else; nothing here should grow into a
 * second design system.
 * @module dsh-relay/pages/theme
 */

/** Token definitions, the reset, and the component rules these pages need. */
export const THEME_CSS = `
:root {
  --dsw-font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC',
    'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif;
  --ds-font-family-code: 'SF Mono', 'JetBrains Mono', 'Fira Code', Consolas,
    'Liberation Mono', Menlo, Courier, 'PingFang SC', 'Microsoft YaHei';
  --ds-ease-in-out: cubic-bezier(0.4, 0, 0.2, 1);
  --ds-transition-duration: 0.2s;
}

body {
  --dsw-alias-bg-base: rgb(255, 255, 255);
  --dsw-alias-bg-layer-2: rgb(255, 255, 255);
  --dsw-alias-border-l1: rgba(0, 0, 0, 0.04);
  --dsw-alias-border-l2: rgba(0, 0, 0, 0.1);
  --dsw-alias-border-l3: rgba(0, 0, 0, 0.12);
  --dsw-alias-brand-primary: rgb(15, 17, 21);
  --dsw-alias-button-primary-fill: rgb(15, 17, 21);
  --dsw-alias-button-primary-hover: rgb(67, 69, 74);
  --dsw-alias-interactive-bg-hover: rgba(38, 49, 72, 0.06);
  --dsw-alias-interactive-bg-active: rgba(38, 49, 72, 0.1);
  --dsw-alias-label-primary: rgb(15, 17, 21);
  --dsw-alias-label-secondary: rgb(97, 102, 107);
  --dsw-alias-label-tertiary: rgb(129, 133, 140);
  --dsw-alias-label-caption: rgb(173, 178, 184);
  --dsw-alias-label-primary-foreground: rgb(255, 255, 255);
  --dsw-alias-state-business-primary: rgb(65, 118, 230);
  --dsw-alias-state-error-primary: rgb(236, 19, 19);
  --dsw-alias-state-success-primary: rgb(34, 197, 94);
  --dsw-alias-state-warn-primary: rgb(245, 158, 11);
  --dsw-alias-state-warn-tertiary: rgb(254, 245, 231);
  --dsw-alias-state-warn-label: rgb(221, 134, 41);
  --dsw-specific-login-input: rgb(249, 250, 251);
  --dsw-specific-tip: rgb(245, 246, 247);
  --dsw-shadow-lv3:
    0 0 1px 0 rgba(0, 0, 0, 0.2), 0 0 4px 0 rgba(0, 0, 0, 0.02), 0 12px 32px 0 rgba(0, 0, 0, 0.08);
  --dsw-qr-ink: rgb(15, 17, 21);
  --dsw-qr-paper: rgb(255, 255, 255);
}

body[data-ds-dark-theme] {
  --dsw-alias-bg-base: rgb(21, 21, 23);
  --dsw-alias-bg-layer-2: rgb(44, 44, 46);
  --dsw-alias-border-l1: rgba(255, 255, 255, 0.06);
  --dsw-alias-border-l2: rgba(255, 255, 255, 0.12);
  --dsw-alias-border-l3: rgba(255, 255, 255, 0.16);
  --dsw-alias-brand-primary: rgb(249, 250, 251);
  --dsw-alias-button-primary-fill: rgb(249, 250, 251);
  --dsw-alias-button-primary-hover: rgb(235, 238, 242);
  --dsw-alias-interactive-bg-hover: rgba(255, 255, 255, 0.08);
  --dsw-alias-interactive-bg-active: rgba(255, 255, 255, 0.14);
  --dsw-alias-label-primary: rgb(249, 250, 251);
  --dsw-alias-label-secondary: rgb(207, 211, 214);
  --dsw-alias-label-tertiary: rgb(173, 178, 184);
  --dsw-alias-label-caption: rgb(129, 133, 140);
  --dsw-alias-label-primary-foreground: rgb(15, 17, 21);
  --dsw-alias-state-business-primary: rgb(103, 158, 254);
  --dsw-alias-state-error-primary: rgb(242, 90, 90);
  --dsw-alias-state-warn-tertiary: rgb(39, 36, 31);
  --dsw-specific-login-input: rgb(27, 27, 28);
  --dsw-specific-tip: rgb(53, 54, 56);
  --dsw-qr-ink: rgb(15, 17, 21);
  --dsw-qr-paper: rgb(249, 250, 251);
}

html, body { height: 100%; margin: 0; }

body {
  font-family: var(--dsw-font-family);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-base);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  box-sizing: border-box;
}

button, input, select, textarea { font-family: inherit; }

.card {
  width: min(380px, 100%);
  box-sizing: border-box;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 24px;
  background: var(--dsw-alias-bg-layer-2);
  box-shadow: var(--dsw-shadow-lv3);
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.card.wide { width: min(560px, 100%); }

.brand { display: flex; align-items: center; gap: 8px; color: var(--dsw-alias-brand-primary); }
.brand svg { display: block; }
.brand .wordmark { font-size: 16px; line-height: 24px; font-weight: 600; letter-spacing: 0.08em; }

h1 { margin: 0; font-size: 20px; line-height: 28px; font-weight: 500; }
p { margin: 0; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-secondary); }
.caption { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
code, .mono { font-family: var(--ds-font-family-code); font-size: 13px; line-height: 20px; }

form { display: flex; flex-direction: column; gap: 12px; }
label { font-size: 13px; line-height: 20px; font-weight: 500; }

input[type="text"], input[type="password"] {
  height: 36px;
  box-sizing: border-box;
  width: 100%;
  padding: 0 12px;
  border-radius: 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-specific-login-input);
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
  line-height: 22px;
  outline: none;
  transition: border-color var(--ds-transition-duration) var(--ds-ease-in-out);
}
input:focus-visible { border-color: var(--dsw-alias-state-business-primary); }

button {
  height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 0 14px;
  border: none;
  border-radius: 18px;
  cursor: pointer;
  font-size: 14px;
  line-height: 22px;
  color: var(--dsw-alias-label-primary);
  background: transparent;
  transition: background var(--ds-transition-duration) var(--ds-ease-in-out);
}
button:disabled { cursor: not-allowed; opacity: 0.4; }
button.primary {
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-foreground);
}
button.primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
button.outline { border: 1px solid var(--dsw-alias-border-l2); }
button.outline:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
button.sm { height: 28px; padding: 0 10px; border-radius: 14px; font-size: 12px; line-height: 18px; }

.notice {
  border-radius: 12px;
  padding: 10px 12px;
  font-size: 13px;
  line-height: 20px;
}
.notice.error { background: var(--dsw-alias-state-warn-tertiary); color: var(--dsw-alias-state-error-primary); }
.notice.warn { background: var(--dsw-alias-state-warn-tertiary); color: var(--dsw-alias-state-warn-label); }
.notice.tip { background: var(--dsw-specific-tip); color: var(--dsw-alias-label-secondary); }

.rows { display: flex; flex-direction: column; gap: 8px; }
.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l1);
}
.row .meta { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.row .name { font-size: 14px; line-height: 22px; font-weight: 500; }
.row .sub { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }

.dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.dot.ok { background: var(--dsw-alias-state-success-primary); }
.dot.off { background: var(--dsw-alias-label-caption); }

.qr { display: flex; justify-content: center; padding: 16px; border-radius: 12px; background: var(--dsw-qr-paper); }
.qr svg { width: 100%; height: auto; max-width: 260px; shape-rendering: crispEdges; }

.code {
  text-align: center;
  font-family: var(--ds-font-family-code);
  font-size: 24px;
  line-height: 32px;
  letter-spacing: 0.24em;
  font-weight: 600;
}

.fingerprint { word-break: break-all; color: var(--dsw-alias-label-tertiary); }

@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; animation: none !important; }
}
`

/**
 * Theme bootstrap, inlined right after `<body>`.
 *
 * The harness sets `color-scheme` and the dark attribute synchronously before
 * first paint for the same reason: doing it from a stylesheet media query
 * alone leaves a light flash on a dark device.
 */
export const THEME_BOOT_JS = `
try {
  var dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  document.body.toggleAttribute('data-ds-dark-theme', dark);
} catch (error) { /* a browser without matchMedia simply stays light */ }
`
