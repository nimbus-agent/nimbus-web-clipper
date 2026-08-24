# Security Policy

`nimbus-web-clipper` is a browser extension that talks only to a
**locally-running** Nimbus gateway on `127.0.0.1`. It makes no cloud calls and
holds a single secret: the paired bearer token, which lives in the browser's
extension storage.

## Reporting a vulnerability

Please report security issues privately rather than opening a public issue:

- Use GitHub's [private vulnerability reporting](https://github.com/nimbus-agent/nimbus-web-clipper/security/advisories/new)
  for this repository, or
- Follow the disclosure process in the main
  [Nimbus security policy](https://github.com/nimbus-agent/Nimbus/security/policy).

Please include reproduction steps, the browser + version, and the extension
version. We aim to acknowledge reports within a few business days.

## Security posture

- **Loopback only.** `host_permissions` is restricted to `127.0.0.1` /
  `localhost`; the extension never contacts a remote origin.
- **Owner-consented pairing.** A token is minted only after the owner runs
  `nimbus clip pair` on the gateway and enters the printed one-time code. The
  gateway's pairing window is fail-closed (invariant I30): no live window → no
  token.
- **Token handling.** The bearer token is stored in extension storage, never
  logged, and never written into a page's DOM. The pairing code is never logged.
- **Page access is opt-in, and separate from the network destination.**
  `optional_host_permissions` declares broad match patterns (`http://*/*`,
  `https://*/*`) so the panel can recognise a self-hosted Jira / Jenkins /
  Bitbucket tab, whose hostname cannot be enumerated in advance. Nothing is
  granted at install; a grant is made per host from the Options page and is
  revocable there. It buys reading a tab's URL without a user gesture — it adds
  no destination the extension sends to, which stays loopback.
- **Scoped tokens.** A token carries the gateway scopes the owner chose when
  opening the pairing window (`nimbus clip pair --scopes`, adjusted later with
  `nimbus clip scopes`). The extension cannot request a scope; a route it lacks
  returns 403 and it reports the gap rather than widening anything.
- **Revocation.** A lost or compromised extension is cut off from the gateway
  side with `nimbus clip revoke` — the gateway deletes the token, and any browser
  still holding it gets a 401.

## Scope

Issues in the gateway, the HTTP contract, or connectors belong in the
[Nimbus](https://github.com/nimbus-agent/Nimbus) repository. Issues specific to
the extension code (this repo) belong here.
