/**
 * The file editor — a native Ink screen, replacing the `$EDITOR` handover.
 *
 * The handover (leaving the alternate screen, lending the TTY to vim/nano,
 * taking it back) was the flakiest code in the app and the break in the design
 * language. This screen is deliberately feature-poor: a viewport-rendered
 * textarea, a save, a discard. All editing behaviour lives in the pure reducer
 * (`editorBuffer.ts`); this component is a shell over it.
 *
 * Copy and paste follow the app-wide rule: paste is a text chunk handled by
 * the reducer; copy is the terminal's own selection — the TUI never enables
 * mouse reporting, so left-click drag selects exactly like `cat file`.
 */

import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";

import { Frame } from "../components/Frame.tsx";
import { frameChromeRows } from "../chrome.ts";
import { useTerminalSize, viewportRows } from "../terminal.ts";
import { MenuItem } from "../components/Menu.tsx";
import { badge, glyph, theme } from "../theme.ts";
import {
  clampView,
  editorApplyKeys,
  editorBackspace,
  editorDelete,
  editorFromText,
  editorInsert,
  editorInsertNewline,
  editorIsDirty,
  editorMove,
  editorText,
  editorViewport,
  type EditorBuffer,
} from "../editorBuffer.ts";

export interface FileEditorResult {
  /** The file was written. */
  saved: boolean;
  /** The buffer differed from the loaded file, whether saved or discarded. */
  changed: boolean;
  /** Present when saving failed; the user stays on the screen. */
  error?: string;
}

const MENU = ["Save & exit", "Discard changes", "Cancel"] as const;

export function FileEditorScreen(props: {
  path: string;
  personaName: string;
  onBack: (result: FileEditorResult) => void;
}): React.ReactElement {
  const [original, setOriginal] = useState<string | null>(null);
  const [buf, setBuf] = useState<EditorBuffer | null>(null);
  const [firstRow, setFirstRow] = useState(0);
  const [firstCol, setFirstCol] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuCursor, setMenuCursor] = useState(0);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);

  const size = useTerminalSize();

  const filename = props.path.split("/").pop() ?? props.path;

  useEffect(() => {
    let alive = true;
    Bun.file(props.path)
      .text()
      .catch((e: unknown) => e as Error)
      .then((text) => {
        if (!alive) return;
        if (text instanceof Error) {
          // ENOENT legitimately means "new file, empty buffer". Any other
          // read failure (EACCES, EISDIR, transient I/O) must NOT collapse
          // to "": the editor would then happily save that empty buffer back
          // and destroy the file. Refuse to open instead.
          if ((text as NodeJS.ErrnoException).code === "ENOENT") {
            setOriginal("");
            setBuf(editorFromText(""));
          } else {
            setLoadError(text.message);
          }
          return;
        }
        setOriginal(text);
        setBuf(editorFromText(text));
      });
    return () => {
      alive = false;
    };
  }, [props.path]);

  const dirty = buf !== null && original !== null && editorIsDirty(buf, original);

  async function save(): Promise<boolean> {
    if (buf === null) return false;
    try {
      const text = editorText(buf);
      await Bun.write(props.path, text);
      // Saving in place: the buffer now matches the file, ^s does not leave.
      setOriginal(text);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  }

  useInput((input, key) => {
    if (loadError) {
      // The file never opened; there is no buffer to edit and saving would
      // be destructive. esc is the only way out.
      if (key.escape) props.onBack({ saved: false, changed: false });
      return;
    }
    if (buf === null) return;
    if (menuOpen) {
      if (key.upArrow) setMenuCursor((c) => Math.max(0, c - 1));
      else if (key.downArrow || key.return) {
        if (key.downArrow) {
          setMenuCursor((c) => Math.min(MENU.length - 1, c + 1));
          return;
        }
        const choice = MENU[menuCursor]!;
        setMenuOpen(false);
        if (choice === "Save & exit")
          void save().then((ok) => {
            if (ok) props.onBack({ saved: true, changed: true });
          });
        else if (choice === "Discard changes")
          props.onBack({ saved: false, changed: true });
      } else if (key.escape) setMenuOpen(false);
      return;
    }
    if (key.escape) {
      // Esc IS the go back. A clean file goes straight back; a dirty one
      // asks, because "discard my edits" must never be one accidental key.
      if (!dirty) props.onBack({ saved: false, changed: false });
      else {
        setMenuCursor(0);
        setMenuOpen(true);
      }
      return;
    }
    if (key.ctrl && input === "s") {
      void save();
      return;
    }
    const move = editorApplyKeys(key);
    if (move) {
      const next = editorMove(buf, move, textRows);
      setBuf(next);
      setFirstRow(clampView(next.row, firstRow, textRows));
      setFirstCol(clampView(next.col, firstCol, VIEW_COLS));
      return;
    }
    if (key.return) {
      setBuf(editorInsertNewline(buf));
      return;
    }
    if (key.backspace) {
      setBuf(editorBackspace(buf));
      return;
    }
    if (key.delete) {
      setBuf(editorDelete(buf));
      return;
    }
    if (key.tab) {
      setBuf(editorInsert(buf, "\t"));
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setBuf(editorInsert(buf, input));
    }
  });

  if (buf === null || original === null) {
    return (
      <Frame
        title={["phantombot", props.personaName, "edit", filename]}
        footer={[{ icon: badge.back, key: "esc", label: "Back" }]}
      >
        {loadError ? (
          <Text color={theme.bad}>
            cannot read {filename}: {loadError}
          </Text>
        ) : (
          <Text color={theme.dim}>loading {filename}…</Text>
        )}
      </Frame>
    );
  }

  // Fill the window, like every other screen: the text area runs from the
  // header to the footer, never a fixed block floating in dead space. Chrome
  // inside the frame: header (1), body gap (1), footer (1); the frame's own
  // border cost is added by `frameChromeRows`. The exit menu and any error
  // line render UNDER the text, so the text shrinks for them rather than
  // overflowing the clipped body.
  let textRows = viewportRows(size, EDITOR_CHROME_ROWS + frameChromeRows());
  if (menuOpen) textRows -= MENU.length + 1;
  if (error) textRows -= 1;
  textRows = Math.max(3, textRows);

  const view = editorViewport(buf, firstRow, firstCol, textRows, VIEW_COLS);
  const lineNo = buf.row + 1;
  const colNo = buf.col + 1;

  return (
    <Frame
      title={["phantombot", props.personaName, "edit", filename]}
      status={`${dirty ? `${glyph.up} modified · ` : ""}${lineNo}:${colNo}`}
      footer={[
        { icon: badge.save, key: "^s", label: "Save" },
        { icon: badge.back, key: "esc", label: dirty ? "Menu" : "Back" },
      ]}
    >
      {view.rows.map((r, i) => {
        if (!r.isCursorRow) return <Text key={i}>{r.text || " "}</Text>;
        // The cursor is one reversed cell on the current row, relative to the
        // horizontally scrolled window.
        const rel = buf.col - view.firstCol;
        const pre = r.text.slice(0, Math.max(0, rel));
        const cur = r.text.slice(Math.max(0, rel), Math.max(0, rel) + 1) || " ";
        const post = r.text.slice(Math.max(0, rel) + 1);
        return (
          <Text key={i}>
            {pre}
            <Text backgroundColor={theme.bar.accent} color={theme.bar.bg}>
              {cur}
            </Text>
            {post}
          </Text>
        );
      })}
      {Array.from(
        { length: Math.max(0, textRows - view.rows.length) },
        (_, i) => (
          <Text key={`fill-${i}`}> </Text>
        ),
      )}
      {menuOpen ? (
        <Box flexDirection="column" marginTop={1}>
          {MENU.map((label, i) => (
            <MenuItem
              key={label}
              label={label}
              selected={i === menuCursor}
              activateHint={i === menuCursor ? "↵" : undefined}
              icon={label === "Save & exit" ? badge.save : label === "Discard changes" ? badge.cancel : badge.back}
            />
          ))}
        </Box>
      ) : null}
      {error ? (
        <Text color={theme.warn}>save failed: {error}</Text>
      ) : null}
    </Frame>
  );
}

/** Rows of chrome the editor draws around its text area, inside the frame. */
const EDITOR_CHROME_ROWS = 3;

/** Columns budgeted for the text area before horizontal scrolling. */
const VIEW_COLS = 110;
