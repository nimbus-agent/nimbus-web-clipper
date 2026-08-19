// Renders either preview shape. Pure: takes a Document, returns a fragment.
import type { BriefPreview, ClipPreview, FetchPreview, PreviewField } from "./preview.ts";

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

type AnyPreview = ClipPreview | FetchPreview | BriefPreview;

function isClipPreview(p: AnyPreview): p is ClipPreview {
  return "excerpt" in p;
}

/**
 * Checked BEFORE the clip test and by its own marker field, not by elimination.
 * A brief carries no `excerpt`, so falling through to the fetch branch would
 * render its `fields` and silently drop every source row and the synthesis
 * notice — the two things that make it a consent surface rather than a summary.
 */
function isBriefPreview(p: AnyPreview): p is BriefPreview {
  return "synthesisNotice" in p;
}

export function renderPreview(doc: Document, preview: AnyPreview): DocumentFragment {
  const frag = doc.createDocumentFragment();
  for (const field of preview.fields) {
    frag.append(row(doc, field));
  }
  if (isBriefPreview(preview)) {
    // Every source named individually: a count is not consent to send twenty
    // specific pages.
    const list = doc.createElement("div");
    list.className = "preview__sources";
    for (const source of preview.sources) {
      list.append(row(doc, source));
    }
    frag.append(list);
    for (const body of preview.bodies) {
      // A disclosure, not an always-open block: on a full collection the text
      // would push the Send button off the screen, and a consent surface the
      // user has to scroll past is one they stop reading.
      const details = doc.createElement("details");
      details.className = "preview__passages";
      const summary = doc.createElement("summary");
      summary.textContent = body.label;
      const text = doc.createElement("div");
      text.className = "preview__body";
      // textContent, never innerHTML — this is page content the user selected.
      text.textContent = body.value;
      details.append(summary, text);
      frag.append(details);
    }
    if (preview.indexNotice !== undefined) {
      const indexNote = doc.createElement("p");
      indexNote.className = "preview__note";
      indexNote.textContent = preview.indexNotice;
      frag.append(indexNote);
    }
    const notice = doc.createElement("p");
    notice.className = "preview__note";
    notice.textContent = preview.synthesisNotice;
    frag.append(notice);
    return frag;
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
