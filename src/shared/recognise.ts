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
const JIRA_KEY = /^[A-Za-z]\w*-\d+$/;

interface Match {
  readonly kind: SurfaceKind;
  readonly ref: string;
  /** The normalised path — Jira upper-cases here; every other matcher echoes the input. */
  readonly path: string;
  /** The same path exactly as it appeared in the URL, so the caller knows how many
   *  characters of the incoming path were consumed. */
  readonly matchedPath: string;
}

function matchGithub(s: readonly string[]): Match | null {
  const [owner, repo, section, num] = s;
  if (owner === undefined || repo === undefined || section !== "pull") {
    return null;
  }
  if (num === undefined || !NUMBER.test(num)) {
    return null;
  }
  const path = `/${owner}/${repo}/pull/${num}`;
  return { kind: "pr", ref: `${owner}/${repo} #${num}`, path, matchedPath: path };
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
  const path = `/${project}/-/merge_requests/${num}`;
  return {
    kind: "pr",
    ref: `${project} !${num}`,
    path,
    matchedPath: path,
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
    return null;
  }
  if (num === undefined || !NUMBER.test(num)) {
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
  const path = `/${names.map((n) => `job/${n}`).join("/")}/${num}`;
  return { kind: "build", ref: `${names.join("/")} #${num}`, path, matchedPath: path };
}

function matchJira(s: readonly string[]): Match | null {
  const [section, key] = s;
  if (section !== "browse" || key === undefined || !JIRA_KEY.test(key)) {
    return null;
  }
  // Jira treats issue keys as upper-case; normalising here means one issue has
  // exactly one resolveUrl regardless of how the link was typed.
  const upper = key.toUpperCase();
  return { kind: "issue", ref: upper, path: `/browse/${upper}`, matchedPath: `/browse/${key}` };
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
  // The URL we hand the gateway. It is the ADDRESS-BAR URL with one narrow
  // change: the matched path prefix is swapped for the matcher's normalised form
  // (today only Jira does this, upper-casing the issue key). Everything else —
  // sub-tab segments, query string — is preserved deliberately.
  //
  // Canonicalisation is the GATEWAY's job: canonicalizeUrl drops the fragment,
  // utm_*/click-ids and a trailing slash, then the ladder tries the exact key, the
  // query-stripped key, and up to three trimmed path segments. Doing any of that
  // here would be work the gateway redoes under different rules — and its rules
  // are load-bearing, because externalIdFor hashes canonicalizeUrl's output.
  //
  // Identity normalisation is NOT canonicalisation and stays here: the ladder is
  // case-sensitive, so a lower-cased Jira key would miss rungs 1 and 2 and then
  // trim away the key entirely on rung 3.
  const matchedPrefix = `${split.base}${split.prefix}${match.matchedPath}`;
  const resolveUrl = url.startsWith(matchedPrefix)
    ? `${split.base}${split.prefix}${match.path}${url.slice(matchedPrefix.length)}`
    : url;
  return {
    ok: true,
    product: entry.product,
    kind: match.kind,
    label: labelFor(entry.product, match.kind),
    ref: match.ref,
    resolveUrl,
  };
}

/** "Bitbucket PR · acme/web #482" — the panel header's first line. */
export function surfaceLine(r: Recognition): string | null {
  return r.ok ? `${r.label} · ${r.ref}` : null;
}

/**
 * Whether two recognitions name the SAME indexed item.
 *
 * NOT a URL comparison, and it must not become one: `resolveUrl` above keeps
 * sub-tab segments and the query string on purpose, so `/pull/482` and
 * `/pull/482/files` differ as URLs while being one pull request. The identity is
 * `(product, kind, ref)`, all three of which the matchers normalise.
 *
 * Two UNRECOGNISED pages compare EQUAL: both are "no item here", and their
 * `reason` describes the URL, not a different item. The panel's navigation watcher
 * relies on that — otherwise moving between two unrecognised pages under an open
 * panel would announce a change the user cannot see.
 */
export function sameItem(a: Recognition, b: Recognition): boolean {
  if (!a.ok || !b.ok) {
    return !a.ok && !b.ok;
  }
  return a.product === b.product && a.kind === b.kind && a.ref === b.ref;
}
