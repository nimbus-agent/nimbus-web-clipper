/** Body to send when Readability finds no article: the meta description, else the URL. */
export function fallbackBody(meta: { description?: string; url: string }): string {
  const desc = meta.description?.trim();
  return desc !== undefined && desc !== "" ? desc : meta.url;
}
