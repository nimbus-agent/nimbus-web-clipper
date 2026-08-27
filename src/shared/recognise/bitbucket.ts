import { homeMatch, isNumber, type Match, type ProductRule } from "./rule.ts";

function match(s: readonly string[]): Match | null {
  // Bitbucket Server: /projects/{KEY}/repos/{slug}/pull-requests/{n}
  if (s[0] === "projects" && s[2] === "repos") {
    const [, key, , slug, section, num] = s;
    if (key === undefined || slug === undefined || section !== "pull-requests") {
      return null;
    }
    if (num === undefined || !isNumber(num)) {
      return null;
    }
    const path = `/projects/${key}/repos/${slug}/pull-requests/${num}`;
    return {
      kind: "pr",
      ref: `${key}/${slug} #${num}`,
      path,
      matchedPath: path,
    };
  }
  // Bitbucket Cloud: /{workspace}/{repo}/pull-requests/{n}
  const [workspace, repo, section, num] = s;
  if (workspace === undefined || repo === undefined || section !== "pull-requests") {
    return s[0] === "dashboard" ? homeMatch(`/${s.join("/")}`) : null;
  }
  if (num === undefined || !isNumber(num)) {
    return null;
  }
  const path = `/${workspace}/${repo}/pull-requests/${num}`;
  return {
    kind: "pr",
    ref: `${workspace}/${repo} #${num}`,
    path,
    matchedPath: path,
  };
}

export const bitbucketRule: ProductRule = {
  product: "bitbucket",
  serviceId: "bitbucket",
  name: "Bitbucket",
  hosts: [{ kind: "origin", origin: "https://bitbucket.org" }],
  match,
};
