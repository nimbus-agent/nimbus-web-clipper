// Renders either preview shape. Pure: takes a Document, returns a fragment.
import type { ClipPreview, FetchPreview, PreviewField } from "./preview.ts";

function row(doc: Document, field: PreviewField): HTMLElement {
  const el = doc.createElement("div");
  el.className = "preview__row";
  const label = doc.createElement("span");
  label.className = "preview__label";
  label.textContent = field.label;
  const value = doc.createElement("span");
  value.className = "preview__value";
  // textContent, never innerHTML. Every value here is attacker-controlled by
  // definition — a page title and a URL come from the page being clipped.
  value.textContent = field.value;
  el.append(label, value);
  return el;
}

function isClipPreview(p: ClipPreview | FetchPreview): p is ClipPreview {
  return "excerpt" in p;
}

export function renderPreview(
  doc: Document,
  preview: ClipPreview | FetchPreview,
): DocumentFragment {
  const frag = doc.createDocumentFragment();
  for (const field of preview.fields) {
    frag.append(row(doc, field));
  }
  if (!isClipPreview(preview)) {
    // A fetch sends no body, so there is no body section. Rendering an empty one
    // would imply content the request does not carry.
    return frag;
  }
  const body = doc.createElement("div");
  body.className = "preview__body";
  body.textContent = preview.excerpt;
  frag.append(body);
  if (preview.truncated) {
    const note = doc.createElement("p");
    note.className = "preview__note";
    // Names the FULL length: the user is agreeing to send all of it, not the
    // part shown.
    note.textContent = `Showing the first ${preview.excerpt.length} characters of ${preview.bodyLength}. All of it is sent.`;
    frag.append(note);
  }
  return frag;
}
