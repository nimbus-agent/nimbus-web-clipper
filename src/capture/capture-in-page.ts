// src/capture/capture-in-page.ts
import { Readability } from "@mozilla/readability";
import { declaredCanonicalHref, resolveCanonical } from "../shared/canonical.ts";
import type { CaptureResult } from "../shared/types.ts";
import { fallbackBody } from "./fallback.ts";

function metaDescription(doc: Document): string | undefined {
  const el = doc.querySelector('meta[name="description"]');
  const content = el?.getAttribute("content") ?? undefined;
  return content !== undefined && content.trim() !== "" ? content : undefined;
}

function capture(mode: string): CaptureResult {
  const url = location.href;
  const title = document.title;
  const canonical = resolveCanonical(declaredCanonicalHref(document), url);
  const canonicalPart =
    canonical.kind === "resolved"
      ? { canonicalUrl: canonical.url }
      : canonical.kind === "rejected"
        ? { canonicalRejected: canonical.reason }
        : {};

  if (mode === "selection") {
    const body = (window.getSelection()?.toString() ?? "").trim();
    return { url, ...canonicalPart, title, mode: "selection", body, readableFound: body !== "" };
  }

  // Readability mutates the DOM it parses — give it a clone. document.cloneNode(true)
  // is Mozilla's documented entry: `new Readability(document.cloneNode(true)).parse()`.
  const clone = document.cloneNode(true) as Document;
  const article = new Readability(clone).parse();
  const text = article?.textContent?.trim() ?? "";
  if (text !== "") {
    const articleTitle = article?.title;
    return {
      url,
      ...canonicalPart,
      title:
        articleTitle !== undefined && articleTitle !== null && articleTitle !== ""
          ? articleTitle
          : title,
      mode: "article",
      body: text,
      readableFound: true,
    };
  }
  const desc = metaDescription(document);
  return {
    url,
    ...canonicalPart,
    title,
    mode: "article",
    body: fallbackBody(desc !== undefined ? { description: desc, url } : { url }),
    readableFound: false,
  };
}

(globalThis as unknown as { __nimbusCapture: (mode: string) => CaptureResult }).__nimbusCapture =
  capture;
