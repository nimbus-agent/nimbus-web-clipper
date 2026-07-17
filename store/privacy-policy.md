# Privacy Policy — Nimbus Web Clipper

_Last updated: 2026-07-17_

Nimbus Web Clipper is a local-first browser extension. It does not collect,
transmit, sell, or share any personal data, and it contains no analytics or
telemetry.

## What the extension does

When you clip a page or open the related-items panel, the extension sends the
page content (or your selection) to a Nimbus gateway running on your own machine
at `127.0.0.1` (loopback). That is the only network destination the extension
ever contacts. It cannot reach any remote server: the extension declares host
access to `http://127.0.0.1` and `http://localhost` only.

## What is stored, and where

- **Pairing token and gateway origin.** After you pair with your local gateway,
  the extension stores a bearer token and the gateway's loopback origin in the
  browser's local extension storage (`chrome.storage.local`) on your device. The
  token is used only as the `Authorization` header on requests to your local
  gateway. It is never logged, never placed in a web page, and never sent
  anywhere else. You can revoke it at any time on the gateway with
  `nimbus clip revoke`.
- **Offline clip queue.** Clips made while the gateway is unreachable are stored
  locally and retried automatically. The bearer token is not stored in the queue.

All of this data stays on your device. Uninstalling the extension removes it.

## No third parties, no tracking

The extension makes no cloud calls, includes no third-party analytics or
advertising code, and does not track you across sites.

## Contact

Questions: https://github.com/nimbus-agent/nimbus-web-clipper/issues
