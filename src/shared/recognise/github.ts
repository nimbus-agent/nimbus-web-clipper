import { homeMatch, isNumber, lastSegment, type Match, type ProductRule } from "./rule.ts";

function match(s: readonly string[]): Match | null {
  const [owner, repo, section, num] = s;

  // A source file: /{owner}/{repo}/blob/{ref}/{path}. Checked BEFORE the PR shape
  // declines below, but gated on `section === "blob"`, so /pull/482/files can never
  // land here — it is a pull request, and the PR arm above owns it.
  if (owner !== undefined && repo !== undefined && section === "blob") {
    const refAndPath = s.slice(3).join("/");
    // A ref alone is a tree listing, not a file: `/blob/main` has nothing to answer
    // about. At least one path segment after the ref is required.
    if (s.length < 5 || refAndPath === "") return null;
    const path = `/${owner}/${repo}/blob/${refAndPath}`;
    return {
      kind: "file",
      ref: `${owner}/${repo} ${lastSegment(refAndPath)}`,
      path,
      matchedPath: path,
      forgeFile: { repo: `${owner}/${repo}`, refAndPath },
    };
  }

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
  corpus: "GitHub repositories",
  selfHostable: true,
  match,
};
