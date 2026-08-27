import { homeMatch, type Match, type ProductRule } from "./rule.ts";

const JIRA_KEY = /^[A-Za-z]\w*-\d+$/;

function match(s: readonly string[]): Match | null {
  const [section, key] = s;
  if (section !== "browse" || key === undefined || !JIRA_KEY.test(key)) {
    // Cloud's "Your work" and Server's dashboard servlet.
    const isHome =
      (s.length === 2 && section === "jira" && key === "your-work") ||
      (s.length === 2 && section === "secure" && key === "Dashboard.jspa");
    return isHome ? homeMatch(`/${s.join("/")}`) : null;
  }
  // Jira treats issue keys as upper-case; normalising here means one issue has
  // exactly one resolveUrl regardless of how the link was typed.
  const upper = key.toUpperCase();
  return { kind: "issue", ref: upper, path: `/browse/${upper}`, matchedPath: `/browse/${key}` };
}

export const jiraRule: ProductRule = {
  product: "jira",
  serviceId: "jira",
  name: "Jira",
  // Every Jira Cloud tenant is its own host (`acme.atlassian.net`), so the hosts
  // cannot be enumerated and the grant is a subdomain wildcard.
  hosts: [{ kind: "suffix", suffix: ".atlassian.net", pattern: "https://*.atlassian.net/*" }],
  match,
};
