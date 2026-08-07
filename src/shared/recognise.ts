// Pure page classification: URL + the user's configured origins → what item this
// page is. No I/O, no chrome.*, no DOM — the service worker calls this before it
// asks the gateway anything.
//
// The product is NEVER guessed from the path. A proxied or path-prefixed
// self-hosted instance would produce a confidently wrong header, and on a surface
// whose whole job is recognition, a wrong header is worse than no header.
import { matchOrigin, splitOrigin } from "./origins.ts";
import type { ConfiguredOrigin, Product, Recognition, SurfaceKind } from "./types.ts";

/** SaaS hosts that need no configuration. Jira Cloud is handled separately —
 *  every tenant has its own *.atlassian.net host, which is not enumerable. */
export const BUILT_IN_ORIGINS: readonly ConfiguredOrigin[] = [
  { origin: "https://bitbucket.org", product: "bitbucket" },
  { origin: "https://github.com", product: "github" },
  { origin: "https://gitlab.com", product: "gitlab" },
];

const ATLASSIAN_SUFFIX = ".atlassian.net";

const PRODUCT_NAMES: Record<Product, string> = {
  bitbucket: "Bitbucket",
  github: "GitHub",
  gitlab: "GitLab",
  jenkins: "Jenkins",
  jira: "Jira",
};

const KIND_NAMES: Record<SurfaceKind, string> = {
  pr: "PR",
  build: "build",
  issue: "issue",
};

const NUMBER = /^\d+$/;
const JIRA_KEY = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

interface Match {
  readonly kind: SurfaceKind;
  readonly ref: string;
  /** The item's own path, relative to the configured prefix. */
  readonly path: string;
}

function matchGithub(s: readonly string[]): Match | null {
  const [owner, repo, section, num] = s;
  if (owner === undefined || repo === undefined || section !== "pull") {
    return null;
  }
  if (num === undefined || !NUMBER.test(num)) {
    return null;
  }
  return { kind: "pr", ref: `${owner}/${repo} #${num}`, path: `/${owner}/${repo}/pull/${num}` };
}

function matchGitlab(s: readonly string[]): Match | null {
  const dash = s.indexOf("-");
  // At least group/project before the "-" separator.
  if (dash < 2 || s[dash + 1] !== "merge_requests") {
    return null;
  }
  const num = s[dash + 2];
  if (num === undefined || !NUMBER.test(num)) {
    return null;
  }
  const project = s.slice(0, dash).join("/");
  return {
    kind: "pr",
    ref: `${project} !${num}`,
    path: `/${project}/-/merge_requests/${num}`,
  };
}

function matchBitbucket(s: readonly string[]): Match | null {
  // Bitbucket Server: /projects/{KEY}/repos/{slug}/pull-requests/{n}
  if (s[0] === "projects" && s[2] === "repos") {
    const [, key, , slug, section, num] = s;
    if (key === undefined || slug === undefined || section !== "pull-requests") {
      return null;
    }
    if (num === undefined || !NUMBER.test(num)) {
      return null;
    }
    return {
      kind: "pr",
      ref: `${key}/${slug} #${num}`,
      path: `/projects/${key}/repos/${slug}/pull-requests/${num}`,
    };
  }
  // Bitbucket Cloud: /{workspace}/{repo}/pull-requests/{n}
  const [workspace, repo, section, num] = s;
  if (workspace === undefined || repo === undefined || section !== "pull-requests") {
    return null;
  }
  if (num === undefined || !NUMBER.test(num)) {
    return null;
  }
  return {
    kind: "pr",
    ref: `${workspace}/${repo} #${num}`,
    path: `/${workspace}/${repo}/pull-requests/${num}`,
  };
}

function matchJenkins(s: readonly string[]): Match | null {
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
  if (names.length === 0 || num === undefined || !NUMBER.test(num)) {
    return null;
  }
  const path = names.map((n) => `job/${n}`).join("/");
  return { kind: "build", ref: `${names.join("/")} #${num}`, path: `/${path}/${num}` };
}

function matchJira(s: readonly string[]): Match | null {
  const [section, key] = s;
  if (section !== "browse" || key === undefined || !JIRA_KEY.test(key)) {
    return null;
  }
  // Jira treats issue keys as upper-case; normalising here means one issue has
  // exactly one resolveUrl regardless of how the link was typed.
  const upper = key.toUpperCase();
  return { kind: "issue", ref: upper, path: `/browse/${upper}` };
}

const MATCHERS: Record<Product, (s: readonly string[]) => Match | null> = {
  bitbucket: matchBitbucket,
  github: matchGithub,
  gitlab: matchGitlab,
  jenkins: matchJenkins,
  jira: matchJira,
};

function labelFor(product: Product, kind: SurfaceKind): string {
  if (product === "gitlab" && kind === "pr") {
    return "GitLab MR";
  }
  return `${PRODUCT_NAMES[product]} ${KIND_NAMES[kind]}`;
}

/** Every Jira Cloud tenant is its own host, so it can't live in a fixed table. */
function atlassianEntry(url: URL): ConfiguredOrigin | null {
  return url.hostname.endsWith(ATLASSIAN_SUFFIX) ? { origin: url.origin, product: "jira" } : null;
}

export function recognise(url: string, origins: readonly ConfiguredOrigin[]): Recognition {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "unknown-host" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "unknown-host" };
  }
  // User entries first so a configured prefix can win over a built-in bare host.
  const entry = matchOrigin([...origins, ...BUILT_IN_ORIGINS], parsed) ?? atlassianEntry(parsed);
  if (entry === null) {
    return { ok: false, reason: "unknown-host" };
  }
  const split = splitOrigin(entry.origin);
  if (split === null) {
    return { ok: false, reason: "unknown-host" };
  }
  const rest = parsed.pathname.slice(split.prefix.length);
  const segments = rest.split("/").filter((part) => part !== "");
  const match = MATCHERS[entry.product](segments);
  if (match === null) {
    return { ok: false, reason: "unrecognised-path" };
  }
  // Canonicalisation falls out of reconstruction: the URL parser already
  // lowercased scheme+host and dropped a default port, and rebuilding from the
  // matched item path drops query, fragment, trailing slash and sub-tabs. The
  // configured prefix is preserved — it is what the connector indexed.
  return {
    ok: true,
    product: entry.product,
    kind: match.kind,
    label: labelFor(entry.product, match.kind),
    ref: match.ref,
    resolveUrl: `${split.base}${split.prefix}${match.path}`,
  };
}

/** "Bitbucket PR · acme/web #482" — the panel header's first line. */
export function surfaceLine(r: Recognition): string | null {
  return r.ok ? `${r.label} · ${r.ref}` : null;
}
