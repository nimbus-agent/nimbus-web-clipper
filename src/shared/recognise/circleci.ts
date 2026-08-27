import { homeMatch, isNumber, type Match, type ProductRule } from "./rule.ts";

function match(s: readonly string[]): Match | null {
  const [section, vcs, org, repo, num] = s;
  if (section === "pipelines" && vcs !== undefined && org !== undefined && repo !== undefined) {
    if (num === undefined || !isNumber(num)) {
      return null;
    }
    const path = `/pipelines/${vcs}/${org}/${repo}/${num}`;
    return { kind: "build", ref: `${org}/${repo} #${num}`, path, matchedPath: path };
  }
  // The org- and repo-scoped pipeline lists (`/pipelines/<vcs>/<org>` and
  // `/pipelines/<vcs>/<org>/<repo>`) fall through to here and are declined,
  // not recognised as `home`: `home` claims the WHOLE connector, and neither
  // scope is that. Only the bare `/pipelines` and `/home` dashboards are.
  if (s.length === 1 && (section === "pipelines" || section === "home")) {
    return homeMatch(`/${section}`);
  }
  return null;
}

export const circleciRule: ProductRule = {
  product: "circleci",
  serviceId: "circleci",
  name: "CircleCI",
  hosts: [{ kind: "origin", origin: "https://app.circleci.com" }],
  corpus: "CircleCI pipelines",
  selfHostable: true,
  match,
};
