// src/shared/dom.ts
// The element builder the tag-typed view modules share.
//
// It lived twice, byte for byte, in `brief/brief-view.ts` and
// `options/brief-log-view.ts`. It is here rather than in either of them because
// those are separate entry points with separate bundles, and a view importing
// another page's view to borrow a helper is the wrong dependency to create.
//
// NOT the same helper as the one in `ledger/ledger-view.ts` and
// `options/ledger-summary-view.ts`, which take `(tag, className, text)` with a
// REQUIRED class and return a plain `HTMLElement`. Those two are a different
// function that happens to share a name; unifying them would mean changing
// argument order at every call site in files this sweep is not otherwise
// touching, which is a bigger edit than the duplication is worth.

/**
 * Create an element, optionally with text and a class.
 *
 * `textContent`, never `innerHTML`: every caller here renders gateway-supplied
 * or page-supplied strings, and one of them reaching markup is the difference
 * between a list and an injection.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) {
    node.textContent = text;
  }
  if (className !== undefined) {
    node.className = className;
  }
  return node;
}
