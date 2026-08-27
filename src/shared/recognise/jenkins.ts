import { homeMatch, isNumber, type Match, type ProductRule } from "./rule.ts";

function match(s: readonly string[]): Match | null {
  // Folder-organised Jenkins is the norm, so /job/<name> repeats.
  const names: string[] = [];
  let i = 0;
  while (s[i] === "job") {
    const name = s[i + 1];
    if (name === undefined) {
      return null;
    }
    names.push(name);
    i += 2;
  }
  const num = s[i];
  if (names.length === 0) {
    // The instance root, after any configured path prefix is stripped.
    return s.length === 0 ? homeMatch("/") : null;
  }
  if (num === undefined || !isNumber(num)) {
    return null;
  }
  const jobSegments = names.map((n) => `job/${n}`).join("/");
  const path = `/${jobSegments}/${num}`;
  return { kind: "build", ref: `${names.join("/")} #${num}`, path, matchedPath: path };
}

export const jenkinsRule: ProductRule = {
  product: "jenkins",
  serviceId: "jenkins",
  name: "Jenkins",
  // Jenkins is self-hosted only; it has no built-in host and reaches recognise()
  // solely through a user-configured origin.
  hosts: [],
  corpus: "Jenkins builds",
  selfHostable: true,
  match,
};
