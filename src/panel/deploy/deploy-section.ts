// src/panel/deploy/deploy-section.ts
// The deploy-readiness section's controller (C10). Asks the worker for a
// verdict on mount, renders one of four states — loading, bound verdict,
// unbound bind form, refusal — and re-asks after a successful bind. No
// chrome.*, no fetch: it is handed `send` by its caller, same shape as every
// other panel-in-page.ts message round trip, so it stays unit-testable in
// jsdom like the renderer it calls.
import {
  type DeployRefusal,
  isDeployPreflightResponse,
  isServiceBindResponse,
  type ServiceBindResponse,
} from "../../shared/messages.ts";
import type { Product, SurfaceKind } from "../../shared/types.ts";
import { renderBindForm, renderDeployBody } from "./deploy-view.ts";

/** The only surfaces a deploy binding can be keyed by. `home` carries no scope
 *  at all (see the recognition doc comment on `Recognition.scope`); `file` has
 *  both forge coordinates but is excluded on judgment. */
export const DEPLOY_SURFACES: readonly SurfaceKind[] = ["pr", "build"];

export function deployBelongsOnSurface(kind: SurfaceKind): boolean {
  return DEPLOY_SURFACES.includes(kind);
}

export type DeployCtx = {
  readonly product: Product;
  readonly scope: string;
  readonly kind: SurfaceKind;
  readonly itemId?: string;
};

export type Send = (msg: unknown) => Promise<unknown>;

/** Single-sourced from `ServiceBindResponse`'s refusal arm rather than a second
 *  hand-typed literal list — the drift class `PRODUCT_IDS`'s doc comment warns
 *  about, one union over. */
type BindRefusal = Extract<ServiceBindResponse, { readonly ok: false }>["reason"];

const BIND_REFUSAL_NOTE: Record<BindRefusal, (serviceId: string) => string> = {
  unknown_service: (id) => `Nimbus has no [metrics.dora.${id}] block configured for that id.`,
  unreachable: () => "Couldn't reach Nimbus to bind that service.",
  server_error: () => "Nimbus hit an error binding that service — try again.",
  malformed: () => "Nimbus sent back something this panel couldn't parse.",
};

const PREFLIGHT_REFUSAL_NOTE: Record<Exclude<DeployRefusal, "unbound">, string> = {
  unreachable: "Nimbus could not reach the deploy checks for this service.",
  server_error: "Nimbus hit an error checking deploy readiness.",
  malformed: "Nimbus sent back something this panel couldn't parse.",
};

const MALFORMED_NOTE = "Nimbus sent back something this panel couldn't parse.";

const KEY = Symbol.for("nimbus.deploy.key");

function ctxKey(ctx: DeployCtx): string {
  return `${ctx.product}:${ctx.scope}:${ctx.itemId ?? ""}`;
}

function statusParagraph(doc: Document, className: string, text: string): HTMLElement {
  const p = doc.createElement("p");
  p.className = className;
  p.textContent = text;
  return p;
}

/**
 * `mountDeploySection` is **idempotent for an unchanged `ctx`**: `paint()` in
 * panel-in-page.ts calls this on roughly twenty occasions — every ambient
 * tick, every related load, every lane transition — and a section that re-asked
 * on each one would both spend a request and wipe out whatever the user was
 * typing into the bind input. The key lives ON THE HOST, not in module state,
 * because panel.js re-evaluates in a fresh scope per injection (see
 * `createPanel`'s own doc comment on the same tradeoff) — a host-scoped key
 * needs no reset step for that same reason.
 */
export function mountDeploySection(host: HTMLElement, ctx: DeployCtx, send: Send): void {
  const key = ctxKey(ctx);
  const marked = host as HTMLElement & { [KEY]?: string };
  if (marked[KEY] === key) {
    return;
  }
  marked[KEY] = key;

  const doc = host.ownerDocument ?? document;

  function renderMalformed(): void {
    host.replaceChildren(statusParagraph(doc, "nimbus-deploy__gap", MALFORMED_NOTE));
  }

  function renderRefusal(reason: Exclude<DeployRefusal, "unbound">): void {
    host.replaceChildren(
      statusParagraph(doc, "nimbus-deploy__gap", PREFLIGHT_REFUSAL_NOTE[reason]),
    );
  }

  function renderBindFormState(guess: string, note?: string): void {
    const form = renderBindForm(doc, guess);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const input = form.querySelector("input");
      const serviceId = (input?.value ?? "").trim();
      if (serviceId === "") {
        return;
      }
      submitBind(serviceId).catch(renderMalformed);
    });
    host.replaceChildren(
      ...(note === undefined ? [] : [statusParagraph(doc, "nimbus-deploy__gap", note)]),
      form,
    );
  }

  async function ask(): Promise<void> {
    const res = await send({
      kind: "deploy-preflight",
      product: ctx.product,
      scope: ctx.scope,
      ...(ctx.itemId === undefined ? {} : { itemId: ctx.itemId }),
    });
    if (!isDeployPreflightResponse(res)) {
      renderMalformed();
      return;
    }
    if (res.ok) {
      host.replaceChildren(renderDeployBody(doc, res.preflight));
      return;
    }
    if (res.reason === "unbound") {
      renderBindFormState(res.guessServiceId ?? "");
      return;
    }
    renderRefusal(res.reason);
  }

  async function submitBind(serviceId: string): Promise<void> {
    const res = await send({
      kind: "service-bind",
      binding: { product: ctx.product, scope: ctx.scope, serviceId },
    });
    if (!isServiceBindResponse(res)) {
      renderMalformed();
      return;
    }
    if (res.ok) {
      // Re-ask rather than assume: the bind just landed on the worker side, and
      // the verdict it unlocks is the worker's to compute, not ours to guess —
      // this is the "without a page refresh" half of the requirement.
      await ask();
      return;
    }
    renderBindFormState(serviceId, BIND_REFUSAL_NOTE[res.reason](serviceId));
  }

  host.replaceChildren(statusParagraph(doc, "nimbus-deploy__status", "Checking deploy readiness…"));
  ask().catch(renderMalformed);
}
