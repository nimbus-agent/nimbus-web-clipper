// src/panel/deploy/deploy-css.ts
// Styles for the deploy-readiness section.
//
// Its own module, beside its renderer, for the reason findings-css.ts states:
// the panel is a Shadow DOM, so all CSS is inline, and STYLES in
// panel-in-page.ts is long enough already.
// The section is a SIBLING of .nimbus-related__shell, not a child of it, so it
// inherits none of the shell's insets and has to state the panel's conventions
// itself: a titled block with the lanes' 16px horizontal inset and the same
// closing border. Without that, the verdict and the bind input sit flush
// against the panel edge while every line above them is inset — the exact
// mismatch panel-in-page.ts's .nimbus-related__lane-body comment warns about.
export const DEPLOY_CSS = `
  .nimbus-deploy-section { border-bottom: 1px solid var(--nimbus-border); }
  /* Mirrors .nimbus-related__lane-title (panel-in-page.ts) minus the pointer:
     this section is not collapsible, so its heading is not a control. */
  .nimbus-deploy__title { margin: 0; padding: 10px 16px; font-weight: 600; }
  /* The lanes' body inset, .nimbus-related__lane-body, spelled for this section.
     Everything below styles content INSIDE this box, so nothing else in this
     file carries horizontal padding of its own. */
  .nimbus-deploy__body { padding: 4px 16px 12px; }
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
