// src/capture/capture-in-page.ts
import { Readability } from "@mozilla/readability";
import type { CaptureResult } from "../shared/types.ts";
import { fallbackBody } from "./fallback.ts";

function metaDescription(doc: Document): string | undefined {
  for (const selector of ['meta[name="description"]', 'meta[property="og:description"]']) {
    const content = doc.querySelector(selector)?.getAttribute("content") ?? undefined;
    if (content !== undefined && content.trim() !== "") return content;
  }
  return undefined;
}

function canonicalUrl(doc: Document): string | undefined {
  const href = doc.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? undefined;
  return href !== undefined && href !== "" ? href : undefined;
}

function capture(mode: string): CaptureResult {
  const url = location.href;
  const title = document.title;
  const canonical = canonicalUrl(document);
  const canonicalPart = canonical !== undefined ? { canonicalUrl: canonical } : {};

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
