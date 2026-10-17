// src/palette/palette-css.ts
// The command palette's inlined styles. Same rule as the panel's STYLES
// (panel-in-page.ts): `:host { all: initial }` drops the page's inherited
// styles, only our own --nimbus-* tokens are referenced, and the dark set sits
// behind prefers-color-scheme. The token values are the panel's, so the two
// overlays read as one product when both are on screen.

/** The panel's width (`.nimbus-related` in panel-in-page.ts). The palette sits
 *  to its left when the panel is open at mount, and never covers it. */
const PANEL_WIDTH = "340px";

export const PALETTE_CSS = `
:host {
  all: initial;
  --nimbus-bg: #ffffff;
  --nimbus-fg: #1a1a1a;
  --nimbus-muted: #666666;
  --nimbus-border: rgba(0, 0, 0, 0.12);
  --nimbus-accent: #2d6cdf;
}
@media (prefers-color-scheme: dark) {
  :host {
    --nimbus-bg: #1e1e1e;
    --nimbus-fg: #eaeaea;
    --nimbus-muted: #a0a0a0;
    --nimbus-border: rgba(255, 255, 255, 0.16);
    --nimbus-accent: #6ea8ff;
  }
}
.nimbus-palette {
  position: fixed;
  top: 64px;
  left: 50%;
  transform: translateX(-50%);
  width: min(480px, calc(100vw - 32px));
  box-sizing: border-box;
  z-index: 2147483647;
  background: var(--nimbus-bg);
  color: var(--nimbus-fg);
  font-family: system-ui, sans-serif;
  font-size: 14px;
  line-height: 1.4;
  border: 1px solid var(--nimbus-border);
  border-radius: 10px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.25);
  overflow: hidden;
}
/* The panel is open: sit in the space to its left, 16px clear of it. */
.nimbus-palette--beside-panel {
  left: auto;
  right: calc(${PANEL_WIDTH} + 16px);
  transform: none;
  width: max(200px, min(480px, calc(100vw - ${PANEL_WIDTH} - 32px)));
}
.nimbus-palette__input {
  all: unset;
  box-sizing: border-box;
  display: block;
  width: 100%;
  padding: 12px 16px;
  font: inherit;
  color: inherit;
  border-bottom: 1px solid var(--nimbus-border);
}
.nimbus-palette__input::placeholder { color: var(--nimbus-muted); }
.nimbus-palette__list {
  list-style: none;
  margin: 0;
  padding: 4px 0;
  max-height: 60vh;
  overflow-y: auto;
}
.nimbus-palette__row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 16px;
  cursor: pointer;
}
.nimbus-palette__row[aria-selected="true"] { background: var(--nimbus-accent); color: #ffffff; }
.nimbus-palette__row[aria-disabled="true"] { cursor: default; color: var(--nimbus-muted); }
.nimbus-palette__title { overflow-wrap: anywhere; }
.nimbus-palette__hint { flex: none; font-size: 12px; color: var(--nimbus-muted); }
.nimbus-palette__row[aria-selected="true"] .nimbus-palette__hint { color: inherit; opacity: 0.85; }
`;
