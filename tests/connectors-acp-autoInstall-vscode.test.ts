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
  reconcileEditorConnectors,
  vscodeResultToConnector,
  VSCODE_EDITOR,
  type EditorSpec,
} from "../src/connectors/acp/autoInstall.ts";
import type { VscodeInstallResult } from "../src/connectors/acp/installVscode.ts";

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
