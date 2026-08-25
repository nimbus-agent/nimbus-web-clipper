# Privacy Policy — Nimbus Web Clipper

_Last updated: 2026-08-24_

Nimbus Web Clipper is a local-first browser extension. It does not collect,
transmit, sell, or share any personal data, and it contains no analytics or
telemetry.

## What the extension does

When you clip a page, open the related-items panel, run one of the panel's
agent lanes, or ask a research brief, the extension sends what you asked about —
the page content, your selection, or the address, title and readable text of
each tab you picked for a brief — to a Nimbus gateway running on your own
machine at `127.0.0.1` (loopback). **That is
the only network destination the extension ever contacts.** Every request it
makes goes there; it has no code path that sends anything anywhere else.

The extension declares host access to `http://127.0.0.1` and `http://localhost`
only. It separately declares *optional* page-access patterns (`http://*/*`,
`https://*/*`), which let it recognise the site you are on — a GitHub pull
request, a self-hosted Jira issue — without you clicking first. Nothing is
granted at install: you grant a specific site from the Options page and can
revoke it there. Granting a site does not make the extension send anything to
it.

## What is stored, and where

Everything below lives in the browser's local extension storage
(`chrome.storage.local`) on your device only. None of it is synced, uploaded, or
shared.

- **Pairing token and gateway origin.** After you pair with your local gateway,
  the extension stores a bearer token and the gateway's loopback origin. The
  token is used only as the `Authorization` header on requests to your local
  gateway. It is never logged, never placed in a web page, and never sent
  anywhere else. You can revoke it at any time on the gateway with
  `nimbus clip revoke`.
- **Offline clip queue.** Clips made while the gateway is unreachable are stored
  locally and retried automatically, together with the time the next retry is due
  — your gateway asks the extension to wait after a burst, and that deadline has
  to survive the browser suspending the extension. The bearer token is not stored
  in the queue.
- **Passages you collect.** Text you explicitly add from a page, kept until you
  use it in a brief or clear it.
- **Answers the gateway sent back.** Agent-lane briefs and research-brief
  reports are cached so reopening the panel does not re-ask; they expire, and
  unpairing clears them.
- **A local disclosure log.** One row per research brief you ran — when, the
  question, how many sources, and which model answered — so you can see what was
  asked on your behalf. You can clear it from the Options page.
- **Your settings.** The sites you configured for recognition, which of them may
  show the ambient cue, and your preview / index-search preferences.

Uninstalling the extension removes all of it.

## No third parties, no tracking

The extension makes no cloud calls, includes no third-party analytics or
advertising code, and does not track you across sites.

One thing worth stating plainly, because it is about *your* gateway rather than
this extension: if you ask for a research brief and you have configured your
Nimbus gateway to answer with a remote model, the gateway is the thing that
contacts that model — not this extension, which still only ever talks to
`127.0.0.1`. When that happens the gateway says so, the report shows it, and the
extension records it in the local disclosure log described above.

## Contact

Questions: https://github.com/nimbus-agent/nimbus-web-clipper/issues
