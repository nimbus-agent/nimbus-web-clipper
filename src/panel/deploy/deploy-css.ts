// src/panel/deploy/deploy-css.ts
// Styles for the deploy-readiness section.
//
// Its own module, beside its renderer, for the reason findings-css.ts states:
// the panel is a Shadow DOM, so all CSS is inline, and STYLES in
// panel-in-page.ts is long enough already.
export const DEPLOY_CSS = `
  .nimbus-deploy { overflow-wrap: anywhere; }
  .nimbus-deploy a { color: var(--nimbus-accent); text-decoration: none; }
  .nimbus-deploy__verdict { margin: 0 0 8px; font-weight: 600; }
  .nimbus-deploy__verdict--ok { color: var(--nimbus-accent); }
  .nimbus-deploy__verdict--warn { color: var(--nimbus-muted); }
  .nimbus-deploy__check { margin: 0 0 8px; }
  .nimbus-deploy__check-head { margin: 0; font-size: 12px; }
  .nimbus-deploy__gap {
    margin: 4px 0 0;
    padding: 8px;
    border-radius: 4px;
    background: var(--nimbus-border);
    font-size: 12px;
    color: var(--nimbus-muted);
  }
  .nimbus-deploy__more { margin: 4px 0 0; font-size: 11px; opacity: 0.7; }
  .nimbus-deploy__bind { display: flex; gap: 8px; align-items: flex-end; }
  .nimbus-deploy__status { margin: 0 0 8px; font-size: 12px; color: var(--nimbus-muted); }
`;
