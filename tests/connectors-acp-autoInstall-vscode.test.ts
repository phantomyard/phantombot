/**
 * Editor-connector reconcile tests for the SELF-DRIVEN (VS Code) editor shape.
 *
 * The Zed-shaped settings path is covered by connectors-acp-autoInstall.test.ts.
 * Here we prove the second EditorSpec shape — a `reconcile()`-driven editor that
 * owns its own detect/version/install flow — slots into the same loop with the
 * same guarantees: detection-gated, repair vs report-only, error isolation, and
 * never throwing out of `reconcileEditorConnectors`.
 *
 * These use a FAKE reconcile-driven EditorSpec (no real `code` CLI) plus the
 * real `vscodeResultToConnector` mapper to lock the action vocabulary.
 */

import { describe, expect, test } from "bun:test";

import {
  editorConnectorBroken,
  reconcileEditorConnectors,
  reconcileVscode,
  vscodeResultToConnector,
  VSCODE_EDITOR,
  type EditorSpec,
  type VscodeReconcileHooks,
} from "../src/connectors/acp/autoInstall.ts";
import type { VscodeInstallResult } from "../src/connectors/acp/installVscode.ts";
import type { ProposedApiResult } from "../src/connectors/acp/vscodeArgv.ts";

const BIN = "/home/dev/.local/bin/phantombot";

function vscodeResult(
  over: Partial<VscodeInstallResult>,
): VscodeInstallResult {
  return {
    code: 0,
    action: "not-detected",
    bundledVersion: "0.1.0",
    message: "x",
    ...over,
  };
}

describe("vscodeResultToConnector mapping", () => {
  test("repair mode maps installed→registered, updated→updated", () => {
    expect(
      vscodeResultToConnector(vscodeResult({ action: "installed", codeCommand: "code" }), true)
        .action,
    ).toBe("registered");
    expect(
      vscodeResultToConnector(vscodeResult({ action: "updated", codeCommand: "code" }), true)
        .action,
    ).toBe("updated");
  });

  test("report-only mode maps would-install/would-update → stale (no claim of work)", () => {
    expect(
      vscodeResultToConnector(vscodeResult({ action: "installed", codeCommand: "code" }), false)
        .action,
    ).toBe("stale");
    expect(
      vscodeResultToConnector(vscodeResult({ action: "updated", codeCommand: "code" }), false)
        .action,
    ).toBe("stale");
  });

  test("not-detected and current pass through; code CLI carried as settingsPath", () => {
    const nd = vscodeResultToConnector(vscodeResult({ action: "not-detected" }), true);
    expect(nd.action).toBe("not-detected");
    expect(nd.settingsPath).toBe("");
    const cur = vscodeResultToConnector(
      vscodeResult({ action: "current", codeCommand: "/usr/bin/code" }),
      true,
    );
    expect(cur.action).toBe("current");
    expect(cur.settingsPath).toBe("/usr/bin/code");
  });

  test("error carries the message", () => {
    const r = vscodeResultToConnector(
      vscodeResult({ action: "error", code: 1, message: "install-extension failed" }),
      true,
    );
    expect(r.action).toBe("error");
    expect(r.error).toContain("install-extension failed");
  });
});

describe("reconcile loop with a self-driven editor", () => {
  /** A reconcile-driven spec we can script per-call. */
  function fakeVscode(
    fn: (opts: { repair: boolean }) => ReturnType<NonNullable<EditorSpec["reconcile"]>>,
  ): EditorSpec {
    return { id: "vscode", reconcile: ({ repair }) => fn({ repair }) };
  }

  test("delegates to reconcile() and forwards repair flag", () => {
    let sawRepair: boolean | undefined;
    const spec = fakeVscode(({ repair }) => {
      sawRepair = repair;
      return { editor: "vscode", action: "registered", settingsPath: "code" };
    });
    const r = reconcileEditorConnectors({ binaryPath: BIN, repair: true, editors: [spec] });
    expect(sawRepair).toBe(true);
    expect(r[0]!.action).toBe("registered");
  });

  test("report-only passes repair:false down", () => {
    let sawRepair: boolean | undefined;
    const spec = fakeVscode(({ repair }) => {
      sawRepair = repair;
      return { editor: "vscode", action: "stale", settingsPath: "code" };
    });
    reconcileEditorConnectors({ binaryPath: BIN, repair: false, editors: [spec] });
    expect(sawRepair).toBe(false);
  });

  test("a throwing reconcile() is isolated → error, others still run", () => {
    const boom = fakeVscode(() => {
      throw new Error("vscode kaboom");
    });
    const healthy = fakeVscode(() => ({
      editor: "vscode",
      action: "current",
      settingsPath: "code",
    }));
    const r = reconcileEditorConnectors({
      binaryPath: BIN,
      editors: [boom, healthy],
    });
    expect(r[0]!.action).toBe("error");
    expect(r[0]!.error).toContain("vscode kaboom");
    expect(r[1]!.action).toBe("current");
  });

  test("an incomplete settings-editor (no reconcile, missing methods) → error, not a throw", () => {
    const broken: EditorSpec = { id: "halfbaked" };
    const r = reconcileEditorConnectors({ binaryPath: BIN, editors: [broken] });
    expect(r[0]!.action).toBe("error");
    expect(r[0]!.error).toContain("neither reconcile-driven");
  });
});

describe("VSCODE_EDITOR is registered and reconcile-driven", () => {
  test("is exported with a reconcile hook (self-driven shape)", () => {
    expect(VSCODE_EDITOR.id).toBe("vscode");
    expect(typeof VSCODE_EDITOR.reconcile).toBe("function");
  });
});

/**
 * The proposed-api allow-list is the SECOND half of a working VS Code
 * integration, and it has its own failure mode: the extension installs fine,
 * reports `current`, and silently runs degraded on the `@phantombot` participant
 * because `~/.vscode/argv.json` never listed it. These tests pin the gating —
 * especially the negative one, that we do NOT create `~/.vscode/argv.json` for
 * a machine with no VS Code on it.
 */
describe("reconcileVscode — proposed-api allow-list gating", () => {
  function hooks(
    over: Partial<VscodeReconcileHooks> & { calls?: string[] } = {},
  ) {
    const calls: string[] = over.calls ?? [];
    return {
      calls,
      hooks: {
        install: over.install ?? (() => {
          calls.push("install");
          return vscodeResult({ action: "installed" });
        }),
        check: over.check ?? (() => {
          calls.push("check");
          return vscodeResult({ action: "current" });
        }),
        ensureArgv: over.ensureArgv ?? ((): ProposedApiResult => {
          calls.push("ensureArgv");
          return { status: "enabled", argvPath: "/fake/argv.json" };
        }),
        checkArgv: over.checkArgv ?? ((): ProposedApiResult => {
          calls.push("checkArgv");
          return { status: "stale", argvPath: "/fake/argv.json" };
        }),
      } satisfies VscodeReconcileHooks,
    };
  }

  test("VS Code absent ⇒ argv.json is NEVER read or written", () => {
    const { calls, hooks: h } = hooks({
      install: () => vscodeResult({ action: "not-detected" }),
    });
    const r = reconcileVscode(true, h);
    expect(r.action).toBe("not-detected");
    expect(r.proposedApi).toBeUndefined();
    expect(calls).toEqual([]); // no ensureArgv, no checkArgv
  });

  test("a failed extension install ⇒ argv.json is left alone", () => {
    const { calls, hooks: h } = hooks({
      install: () => vscodeResult({ code: 1, action: "error", message: "boom" }),
    });
    const r = reconcileVscode(true, h);
    expect(r.action).toBe("error");
    expect(r.proposedApi).toBeUndefined();
    expect(calls).toEqual([]);
  });

  test("repair mode writes the allow-list after installing", () => {
    const { calls, hooks: h } = hooks();
    const r = reconcileVscode(true, h);
    expect(r.action).toBe("registered");
    expect(r.proposedApi).toBe("enabled");
    expect(calls).toEqual(["install", "ensureArgv"]);
  });

  test("report-only mode checks but never writes the allow-list", () => {
    const { calls, hooks: h } = hooks();
    const r = reconcileVscode(false, h);
    expect(r.proposedApi).toBe("stale");
    expect(calls).toEqual(["check", "checkArgv"]);
  });

  test("an installed-but-not-allow-listed extension reads as BROKEN", () => {
    // The whole point: action is `current` (extension is fine) yet the box is
    // running degraded. Doctor must not print a green tick here.
    const { hooks: h } = hooks();
    const r = reconcileVscode(false, h);
    expect(r.action).toBe("current");
    expect(editorConnectorBroken(r)).toBe(true);
  });

  test("a freshly-enabled allow-list does NOT read as broken", () => {
    const { hooks: h } = hooks();
    const r = reconcileVscode(true, h);
    expect(r.proposedApi).toBe("enabled");
    expect(editorConnectorBroken(r)).toBe(false);
  });

  test("an argv.json error surfaces as broken, with its detail", () => {
    const { hooks: h } = hooks({
      ensureArgv: () => ({
        status: "error",
        argvPath: "/fake/argv.json",
        error: "not parseable as JSONC",
      }),
    });
    const r = reconcileVscode(true, h);
    expect(r.proposedApi).toBe("error");
    expect(r.proposedApiError).toContain("not parseable");
    expect(editorConnectorBroken(r)).toBe(true);
  });

  test("an allow-listed, current extension is healthy and quiet", () => {
    const { hooks: h } = hooks({
      checkArgv: () => ({ status: "current", argvPath: "/fake/argv.json" }),
    });
    const r = reconcileVscode(false, h);
    expect(r.action).toBe("current");
    expect(r.proposedApi).toBe("current");
    expect(editorConnectorBroken(r)).toBe(false);
  });
});
