# Design Review: Gateway Activity Ledger

> **Historical.** This is the review as written against the first draft, kept
> for the record. Every point was answered — see the design doc and the commits
> that followed. One item has since been overtaken by fact: the re-pairing
> concern below assumes the `egress` scope needs a new pairing. It does not.
> `nimbus clip scopes <device> --set <scopes>` grants it to an existing pairing
> in place, and the design and CHANGELOG say so.

This document contains open questions, suggestions, and improvements for the [Gateway Activity Ledger Design Spec (2026-08-23)](./2026-08-23-gateway-activity-ledger-design.md).

---

## 1. Security & Cryptographic Risks

### Signing Oracle via `GET /v1/egress/prove` (U1)
* **Concern:** The design notes that `GET /v1/egress/prove` exposes a signing oracle over ledger-derived digests using the Vault share keypair.
* **Open Questions:**
  * If a pairing token is compromised, does this allow an attacker to sign arbitrary digests that mimic legitimate ledger windows?
  * What is the blast radius of a compromised signature? Can it be used to forge other proofs or gain administrative privileges?
* **Suggestions:**
  * **Key Separation:** Instead of signing with the main Vault share keypair, consider deriving a ledger-specific signing key (e.g., using HKDF from the Vault key) or generating a pairing-specific session key.
  * **Rate Limiting:** Implement strict rate limits specifically for the `prove` route.

---

## 2. User Experience (UX)

### Re-pairing Friction
* **Concern:** "An already-paired user has to re-pair to see their ledger."
* **Suggestions:**
  * Provide a clear and streamlined "Upgrade Permissions" or "Re-authorize" flow inside the extension UI (Options/Activity page) that requests the new `egress` scope, rather than requiring the user to delete and re-establish the pairing from scratch.

### Verification Failure Response
* **Concern:** "A failed verify is loud: the page states the chain did not verify and stops presenting the list as trustworthy."
* **Suggestions:**
  * Define what user actions should follow a verification failure (e.g., alert of potential tampering, database corruption, or sync errors).
  * Provide a "Download debug state" or "Export broken ledger" action to facilitate diagnostic troubleshooting without compromising security.

---

## 3. Data Privacy & Multi-Client Isolation

### Cross-Client Data Leakage
* **Concern:** Under U2, targeted-fetch rows will record item identities using a `{ service, type, id }` triple.
* **Open Questions:**
  * In a multi-client setup (e.g., a shared gateway with a browser extension and a VS Code extension used by different entities/profiles), can Client A view the specific item IDs fetched by Client B?
  * Could the `id` field itself leak sensitive information (e.g., user email, private document titles, or tokens embedded in IDs)?
* **Suggestions:**
  * Assess if `id` needs to be hashed or obfuscated for certain services, or if ledger access should be restricted to client-specific sub-ledgers.

---

## 4. Performance & Scale

### Ledger Pagination
* **Concern:** The `GET /v1/egress` route returns rows in a window with a limit (default 1000, ceiling 5000).
* **Open Questions:**
  * For active users, the ledger could grow rapidly. How does the Activity page handle pagination when the toggle reveals the full window?
  * Will the API support cursor-based pagination to avoid performance degradation when scrolling through thousands of ledger rows?
