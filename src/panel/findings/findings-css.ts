// src/panel/findings/findings-css.ts
// Styles for the structured findings views.
//
// Its own module because the panel is a Shadow DOM: external stylesheets do not
// apply, so all CSS is inline, and `STYLES` in panel-in-page.ts is already
// carrying a 2,100-line file. Seven renderers' worth of rules belong beside the
// renderers.
export const FINDINGS_CSS = `
  .nimbus-findings__gaps { margin: 8px 0 0; padding: 8px; border-radius: 4px; }
  .nimbus-findings__gap { margin: 0 0 4px; font-size: 12px; }
  .nimbus-findings__gap-fix { display: block; opacity: 0.8; }
  .nimbus-findings__provenance { margin: 8px 0 0; font-size: 11px; opacity: 0.7; }
  .nimbus-findings__empty { margin: 0; font-size: 12px; opacity: 0.8; }
  .nimbus-findings__subject { margin: 0 0 8px; font-weight: 600; }
  .nimbus-findings__group { margin: 0 0 10px; }
  .nimbus-findings__group-title { font-size: 11px; text-transform: uppercase; opacity: 0.7; }
  .nimbus-findings__item { margin: 0 0 6px; }
  .nimbus-findings__item-detail { display: block; font-size: 12px; opacity: 0.85; }
  .nimbus-findings__item-when { font-size: 11px; opacity: 0.6; }
`;
