import { homeMatch, isNumber, lastSegment, type Match, type ProductRule } from "./rule.ts";

function match(s: readonly string[]): Match | null {
  const dash = s.indexOf("-");

  // A source file: /{group}/…/{project}/-/blob/{ref}/{path}.
  //
  // Keyed on the `/-/` delimiter rather than a segment count, which is what makes
  // arbitrary group nesting work: GitLab projects live under any number of groups, so
  // everything BEFORE the dash is the project coordinate — two segments or five.
  if (dash >= 2 && s[dash + 1] === "blob") {
    const refAndPath = s.slice(dash + 2).join("/");
    // A ref alone is a tree listing, not a file.
    if (s.length < dash + 4 || refAndPath === "") return null;
    const project = s.slice(0, dash).join("/");
    const path = `/${project}/-/blob/${refAndPath}`;
    return {
      kind: "file",
      ref: `${project} ${lastSegment(refAndPath)}`,
      path,
      matchedPath: path,
      forgeFile: { repo: project, refAndPath },
    };
  }

  // At least group/project before the "-" separator.
  if (dash < 2 || s[dash + 1] !== "merge_requests") {
    // Not an MR path: the only other GitLab pages recognised are the two spellings
    // of the instance home, "" and "dashboard".
    if (s.length === 0) return homeMatch("/");
    if (s.length === 1 && s[0] === "dashboard") return homeMatch("/dashboard");
    return null;
  }
  const num = s[dash + 2];
  if (num === undefined || !isNumber(num)) {
    return null;
  }
  const project = s.slice(0, dash).join("/");
  const path = `/${project}/-/merge_requests/${num}`;
  return {
    kind: "pr",
    ref: `${project} !${num}`,
    path,
    matchedPath: path,
  };
}

export const gitlabRule: ProductRule = {
  product: "gitlab",
  serviceId: "gitlab",
  name: "GitLab",
  hosts: [{ kind: "origin", origin: "https://gitlab.com" }],
  corpus: "GitLab projects",
  selfHostable: true,
  match,
};
