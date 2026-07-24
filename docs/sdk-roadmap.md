# Nimbus SDK — Roadmap

> **Status:** proposed. This is a direction, not yet a shipped surface. It is
> drafted here because `nimbus-web-clipper` is one of the SDK's first consumers
> and proof surfaces; the canonical home moves to the
> [Nimbus Ecosystem Roadmap](https://github.com/nimbus-agent/Nimbus/blob/main/docs/ecosystem-roadmap.md)
> and a future `nimbus-sdk` repo once Phase 0 lands.

## Why an SDK

Every surface in the Nimbus family talks to the same gateway over the same
locked HTTP contract — and today each one **re-implements that relationship from
scratch**. `nimbus-web-clipper` and `nimbus-vscode` both hand-roll a gateway
client, a pairing flow, a token store, and 429/413/offline handling. The next
surface will copy it again, and the copies will drift.

The SDK's reason to exist is simple: **any repo pulls in the SDK instead of
re-implementing.** It is the shared spine of the Nimbus family, carrying *both*:

- **Common contracts** — the versioned shape of `pair` / `clips` / `related`.
- **Common implementations** — the actual reusable code: gateway client,
  pairing orchestration, typed errors + backoff, the token-store seam.

## Ownership model

- **The spec lives in the gateway** (`nimbus-agent/Nimbus`). The gateway is the
  authority on the contract *and* the thing that implements it, so it can
  contract-test its own server against the spec in CI — killing server-vs-spec
  drift at the source.
- **The SDKs live in a new `nimbus-sdk` satellite repo**, consuming the
  published spec. This matches the satellite pattern already used by
  `nimbus-web-clipper` and `nimbus-vscode`, and decouples SDK release cadence
  from the engine.

## Architecture

Four layers, each independently understandable and testable:

1. **Contract** — a versioned OpenAPI/TypeSpec spec → generated types. The
   single source of truth for request/response shapes.
2. **Client** — transport plus status/error mapping (429 rate-limit, 413
   payload-too-large, offline/retryable, terminal). This is the logic
   `nimbus-web-clipper` already learned the hard way, lifted into one place.
3. **Orchestration** — pure, runtime-agnostic flows: `pair`, `clip`, `related`.
   Generalizes the web-clipper pattern of "pure handlers with injected deps."
4. **Adapter seam** — small interfaces (`TokenStore`, `Fetcher`, optional
   `Logger` / `Clock`) that each repo injects. This is what makes "usable in
   *any* repo" real across different runtimes:

   | Repo | `TokenStore` implementation |
   | --- | --- |
   | web-clipper | `chrome.storage.local` |
   | vscode | extension `SecretStorage` |
   | Node CLI | OS keychain / file |

   The SDK ships a couple of default adapters (e.g. in-memory, `fetch`-based).

### Design principles

- **Zero runtime dependencies.** The core TS SDK ships no third-party runtime
  deps — only types and the adapter seam. Browser and IDE extensions are
  bundle-size- and audit-sensitive (this repo already lives by "bundled, no
  runtime deps"); anything heavier, like an HTTP client, is *injected*, not
  bundled.
- **`Fetcher` mirrors the Web Fetch API** — `(input, init?) => Promise<Response>`.
  Browsers and Node ≥18 pass global `fetch` straight through; VS Code or a
  custom Node host maps its proxy-aware client onto that familiar signature.
- **Retry scope is bounded.** The client layer owns *transient* retry with
  backoff (429 / 503 / offline blips). *Durable* offline queueing — persisting
  unsent clips across restarts — stays with the consumer (web-clipper already
  has one) and, if it ever moves into the SDK, arrives as an *optional*
  `StorageAdapter`, never baked into the core seam. This keeps the adapter
  surface small.

### Invariants travel with the SDK

These are enforced *inside* the SDK so no consumer can accidentally violate them:

- **Loopback only** — origin validation rejects anything but `127.0.0.1` /
  `localhost` (invariant **I6**). The SDK never phones home.
- **The bearer token is never logged**, never placed in a page DOM. Neither is
  the pairing code.
- **Pairing is fail-closed** (invariant **I30**).

## Phases

The ordering is **contract-first, dogfood-then-publish**: prove the API on our
own two surfaces before anyone outside depends on it.

### Phase 0 — Contract formalization *(the keystone)*

Extract the shipped gateway contract (`/v1/clips/pair/confirm`, `/v1/clips`,
`/v1/clips/related`) into a versioned spec in the gateway repo. Prefer
**TypeSpec** as the source of truth (compiled to OpenAPI) — the gateway is
already TypeScript and TypeSpec is far cleaner to maintain than raw OpenAPI YAML,
while still emitting a standard OpenAPI document for codegen.

- Gateway CI contract-tests its own server against the spec, with **strict**
  validation — reject unknown/extra properties in both directions so drift can't
  hide as a silently-ignored field.
- The spec is published as a versioned artifact the SDK repo can pin.
- **Done when:** the spec exists, CI enforces it, and it is consumable
  downstream. No SDK code yet — but nothing below is trustworthy without it.

### Phase 1 — TypeScript SDK, full stack *(internal payoff)*

Stand up `nimbus-sdk` and build the full four-layer stack in TypeScript:
generated types → client → orchestration → adapter seam, plus default adapters.

- Migrate `nimbus-web-clipper` onto it, deleting the duplicated
  `gateway-client.ts`, `handlers.ts`, and `connection-store.ts`.
- Migrate `nimbus-vscode` onto it as well.
- Ship a `MockNimbusGateway` test double from the SDK so consumers unit-test
  against a fake gateway instead of hand-mocking raw fetch.
- Document the `TokenStore` contract, including at-rest expectations — browser
  `chrome.storage` is origin-isolated but not encrypted; a Node keychain adapter
  is encrypted. The interface states what each adapter guarantees so consumers
  choose with eyes open.
- **Done when:** both surfaces run on the SDK with their bespoke gateway code
  removed. This migration *is* the proof that "any repo" works — and the
  API survives real internal use before going public.

### Phase 2 — Public API + Python *(become buildable-on)*

- Stabilize and semver the TypeScript public API; publish to npm with a
  changelog.
- Generate the Python transport from the same spec; hand-write a thin Python
  orchestration layer mirroring the adapter model (for the agent /
  data-science audience). Ship an **execution-neutral core** exposing both sync
  and async entry points — data-science scripts are usually synchronous, agents
  usually async.
- DTOs and serializers in *every* language are **generated** from the spec via a
  standard generator (e.g. `openapi-generator`), never hand-written — only the
  thin orchestration layer is authored per language.
- Docs + examples: "build your own Nimbus surface in ~20 lines."
- **Done when:** the SDK is public, documented, and a non-Nimbus author can ship
  a working surface against it.

### Phase 3 — Agent / extension framework *(deepest belonging)*

Go beyond HTTP. An SDK layer for building Nimbus **agents/plugins** — capture
sources, tools, indexers — that register with the engine rather than merely
calling it. Third parties *extend* Nimbus, not just consume it.

- **Done when:** a third-party plugin can register a capture source or tool the
  engine picks up, with a discovery/registration story documented.

## Cross-cutting notes

- **Versioning:** the SDK major version tracks the contract major version.
- **Token migration:** if a breaking contract major changes the token's shape,
  the SDK does *not* silently migrate. It detects the mismatch and forces
  re-pairing — fail-closed, consistent with I30. Adapters clear local state;
  they never guess at a new shape.
- **The per-language cost, stated honestly:** "multi-language" + "full
  orchestration" means the *orchestration* layer is hand-written once per
  language (TS, then Python). Mitigation — keep orchestration thin; the bulk of
  the value (types + transport) is *generated* from the spec, so the
  hand-written part per language stays small.
- **Scope discipline:** each phase is independently shippable and useful.
  Phase 0 has value (a formal contract) even if Phase 1 slips; Phase 1 has value
  (dedup) even if the SDK never goes public.

## Open questions & non-goals

- **Pairing is local, not OAuth.** The SDK wraps the *existing* contract: the
  owner runs `nimbus clip pair`, and the consumer POSTs the printed 6-digit code
  to `/pair/confirm` to mint a token. There is no browser redirect / OAuth loop
  and none is planned — the loopback origin check (**I6**) is the trust boundary,
  and the SDK enforces it so no consumer can point at a non-loopback host.
- **Real-time transport (WebSocket / SSE) is a non-goal for now.** The contract
  is request/response HTTP. The `Fetcher` seam is deliberately narrow but doesn't
  preclude a future socket adapter; nothing here builds one until the gateway
  grows a real-time surface.
- **Origin / CSRF hardening** beyond the loopback check is the gateway's
  responsibility, not the SDK's — the SDK's job is to never *become* the vector
  (loopback-only, token never logged).

## How this repo relates

`nimbus-web-clipper` is a **Phase 1 consumer and proof surface**. The work here
is the migration: replace this repo's hand-rolled gateway client, handlers, and
token store with the SDK once Phase 1 lands, keeping the same behavior and
invariants. Until then, this repo's local implementation is the reference the
SDK generalizes from.
