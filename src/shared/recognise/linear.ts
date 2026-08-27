import { homeMatch, type Match, type ProductRule } from "./rule.ts";

// Same shape jira.ts uses: a leading letter, then any word characters, then a
// dash and digits. A purely numeric prefix ("123-456") is far more likely to be
// some other path segment than a team key, and a wrong header is worse than no
// header — so this deliberately declines it rather than widening to match.
const LINEAR_KEY = /^[A-Za-z]\w*-\d+$/;

function match(s: readonly string[]): Match | null {
  const [workspace, section, key, ...rest] = s;
  // The workspace segment is what makes a Linear URL a workspace's — the bare
  // `linear.app` root (no workspace) is the marketing site, not a dashboard.
  if (workspace === undefined || section === undefined) {
    return null;
  }
  if (section === "issue") {
    if (key === undefined || !LINEAR_KEY.test(key)) {
      return null;
    }
    // Linear's match ladder is case-sensitive like Jira's, so a lower-cased key
    // would miss every rung and then trim away entirely. Normalising here means
    // one issue has exactly one resolveUrl regardless of how the link was typed.
    const upper = key.toUpperCase();
    return {
      kind: "issue",
      ref: upper,
      path: `/${workspace}/issue/${upper}`,
      matchedPath: `/${workspace}/issue/${key}`,
    };
  }
  if (rest.length === 0 && (section === "inbox" || section === "my-issues")) {
    return homeMatch(`/${workspace}/${section}`);
  }
  return null;
}

export const linearRule: ProductRule = {
  product: "linear",
  serviceId: "linear",
  name: "Linear",
  hosts: [{ kind: "origin", origin: "https://linear.app" }],
  corpus: "Linear issues",
  // Linear has no self-hosted edition — the first product this flag was added
  // for. Offering it in the Options page's self-hosted picker would invite a
  // user to configure an origin that cannot exist.
  selfHostable: false,
  match,
};
