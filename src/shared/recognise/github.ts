import { homeMatch, isNumber, type Match, type ProductRule } from "./rule.ts";

function match(s: readonly string[]): Match | null {
  const [owner, repo, section, num] = s;
  if (owner === undefined || repo === undefined || section !== "pull") {
    // The signed-in dashboard is the bare root. Checked only after the PR
    // pattern above has declined, so /acme/web/pull/1 can never land here.
    return s.length === 0 ? homeMatch("/") : null;
  }
  if (num === undefined || !isNumber(num)) {
    return null;
  }
  const path = `/${owner}/${repo}/pull/${num}`;
  return { kind: "pr", ref: `${owner}/${repo} #${num}`, path, matchedPath: path };
}

export const githubRule: ProductRule = {
  product: "github",
  serviceId: "github",
  name: "GitHub",
  hosts: [{ kind: "origin", origin: "https://github.com" }],
  match,
};
