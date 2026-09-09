/**
 * Standalone Ink flow runner for single wizards (harness, telegram, voice, memory, autostart, create-persona).
 *
 * Runs a single flow in Ink full-screen, handles questions and overlays,
 * cleans up terminal state on completion, and exits back to terminal (code 0).
 */

import React, { useEffect, useRef, useState } from "react";
import { Box, Text, render, useApp } from "ink";

import { Frame, NoticeContext } from "./components/Frame.tsx";
import { ConfirmScreen, type ConfirmRequest } from "./screens/Confirm.tsx";
import { AskScreen, type AskRequest } from "./screens/Ask.tsx";
import { ChooseScreen, type ChooseRequest } from "./screens/Choose.tsx";
import { SearchListScreen, type SearchListRequest } from "./screens/SearchList.tsx";
import {
  BrainTestScreen,
  type BrainTestRequest,
  type BrainTestResult,
} from "./screens/BrainTest.tsx";
import {
  TerminalSizeContext,
  enterFullScreen,
  gateStdout,
  renderRows,
  useTerminalSize,
  KITTY_POP,
  KITTY_PUSH,
  forceRepaint,
} from "./terminal.ts";
import { installStdinTap } from "./stdinTap.ts";
import { lendStdin } from "./stdinHandover.ts";
import { installSignalExit } from "./index.tsx";
import { setPromptHost } from "./prompts.ts";
import { logBuffer } from "./logBuffer.ts";
import { setLogSink } from "../lib/logSink.ts";
import type { Consequence } from "./actions.ts";
import { theme } from "./theme.ts";

export interface StandaloneQuestions {
  choose(input: {
    title: string;
    description?: string;
    options: readonly { value: string; label: string; hint?: string }[];
    initial?: string;
  }): Promise<string | undefined>;
  search(input: {
    title: string;
    banner?: string;
    description?: string;
    options: readonly { value: string; label: string; hint?: string }[];
    initial?: string;
  }): Promise<string | undefined>;
  value(input: {
    title: string;
    hint?: string;
    masked?: boolean;
    initial?: string;
    allowEmpty?: boolean;
  }): Promise<string | undefined>;
  confirm(input: {
    title: string;
    consequence: Consequence;
    danger?: boolean;
    confirmName?: string;
  }): Promise<boolean>;
  testBrain?(input: BrainTestRequest): Promise<BrainTestResult>;
  note(title: string, body: string): void;
}

export type StandaloneFlowFn = (
  q: StandaloneQuestions,
) => Promise<string | number | void>;

export function StandaloneFlowHost(props: {
  title?: string[];
  run: StandaloneFlowFn;
  onDone: (result: string | number | void) => void;
  onError: (err: Error) => void;
}): React.ReactElement {
  const size = useTerminalSize();
  const [ask, setAsk] = useState<
    AskRequest & { resolve: (v: string | undefined) => void }
  >();
  const [choose, setChoose] = useState<
    ChooseRequest & { resolve: (v: string | undefined) => void }
  >();
  const [searchAsk, setSearchAsk] = useState<
    SearchListRequest & { resolve: (v: string | undefined) => void }
  >();
  const [brainTest, setBrainTest] = useState<
    BrainTestRequest & { resolve: (v: BrainTestResult) => void }
  >();
  const [confirm, setConfirm] = useState<
    ConfirmRequest & { resolve: (v: boolean) => void }
  >();
  const [notice, setNotice] = useState<string | undefined>();
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const q: StandaloneQuestions = {
      choose: (input) =>
        new Promise((resolve) => {
          setChoose({ ...input, resolve });
        }),
      search: (input) =>
        new Promise((resolve) => {
          setSearchAsk({ ...input, resolve });
        }),
      value: (input) =>
        new Promise((resolve) => {
          setAsk({ ...input, resolve });
        }),
      confirm: (input) =>
        new Promise((resolve) => {
          setConfirm({ ...input, resolve });
        }),
      testBrain: (input) =>
        new Promise((resolve) => {
          setBrainTest({ ...input, resolve });
        }),
      note: (title, body) => {
        setNotice(title ? `${title}: ${body.split("\n")[0]}` : body);
      },
    };

    void props
      .run(q)
      .then((res) => {
        props.onDone(res);
      })
      .catch((err) => {
        props.onError(err instanceof Error ? err : new Error(String(err)));
      });
  }, [props]);

  if (confirm) {
    return (
      <TerminalSizeContext.Provider value={size}>
        <Box flexDirection="column" height={renderRows(size)}>
          <ConfirmScreen
            request={confirm}
            onAnswer={(yes) => {
              const res = confirm.resolve;
              setConfirm(undefined);
              res(yes);
            }}
          />
        </Box>
      </TerminalSizeContext.Provider>
    );
  }

  if (ask) {
    return (
      <TerminalSizeContext.Provider value={size}>
        <Box flexDirection="column" height={renderRows(size)}>
          <AskScreen
            request={ask}
            onAnswer={(v) => {
              const res = ask.resolve;
              setAsk(undefined);
              res(v);
            }}
          />
        </Box>
      </TerminalSizeContext.Provider>
    );
  }

  if (choose) {
    return (
      <TerminalSizeContext.Provider value={size}>
        <Box flexDirection="column" height={renderRows(size)}>
          <ChooseScreen
            request={choose}
            onAnswer={(v) => {
              const res = choose.resolve;
              setChoose(undefined);
              res(v);
            }}
          />
        </Box>
      </TerminalSizeContext.Provider>
    );
  }

  if (searchAsk) {
    return (
      <TerminalSizeContext.Provider value={size}>
        <Box flexDirection="column" height={renderRows(size)}>
          <SearchListScreen
            request={searchAsk}
            onAnswer={(v) => {
              const res = searchAsk.resolve;
              setSearchAsk(undefined);
              res(v);
            }}
          />
        </Box>
      </TerminalSizeContext.Provider>
    );
  }

  if (brainTest) {
    return (
      <TerminalSizeContext.Provider value={size}>
        <Box flexDirection="column" height={renderRows(size)}>
          <BrainTestScreen
            request={brainTest}
            onAnswer={(res) => {
              const r = brainTest.resolve;
              setBrainTest(undefined);
              r(res);
            }}
          />
        </Box>
      </TerminalSizeContext.Provider>
    );
  }

  return (
    <TerminalSizeContext.Provider value={size}>
      <NoticeContext.Provider value={notice}>
        <Box flexDirection="column" height={renderRows(size)}>
          <Frame
            title={props.title ?? ["phantombot", "setup"]}
            footer={[{ icon: "•", key: "", label: "running..." }]}
          >
            <Box flexDirection="column" padding={1}>
              <Text color={theme.accent}>Working...</Text>
              {notice ? (
                <Box marginTop={1}>
                  <Text color={theme.dim}>{notice}</Text>
                </Box>
              ) : null}
            </Box>
          </Frame>
        </Box>
      </NoticeContext.Provider>
    </TerminalSizeContext.Provider>
  );
}

export async function runStandaloneFlow(
  flow: StandaloneFlowFn,
  title?: string[],
): Promise<number> {
  if (!process.stdin.isTTY) {
    // Non-interactive environment fallback
    return 1;
  }

  const restoreLogs = setLogSink((line) => logBuffer.push(line));
  const fullScreen = enterFullScreen();
  const gate = gateStdout();
  const installed = installStdinTap();

  let exitCode = 0;
  let noticeMessage: string | undefined;
  let instance: ReturnType<typeof render> | undefined;

  const element = (
    <StandaloneFlowHost
      title={title}
      run={async (q) => {
        const res = await flow(q);
        if (typeof res === "string") noticeMessage = res;
        return res;
      }}
      onDone={(res) => {
        if (typeof res === "number") exitCode = res;
        instance?.unmount();
        resolve(exitCode);
      }}
      onError={(err) => {
        noticeMessage = `Error: ${err.message}`;
        exitCode = 1;
        instance?.unmount();
        resolve(1);
      }}
    />
  );

  const restoreHost = setPromptHost(async (fn) => {
    gate.suspend();
    installed.setForwarding(false);
    fullScreen.restore();
    process.stdout.write(KITTY_POP);
    const dropBorrowedListeners = lendStdin(process.stdin);
    try {
      return await fn();
    } finally {
      dropBorrowedListeners();
      process.stdout.write(KITTY_PUSH);
      fullScreen.enter();
      process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
      installed.setForwarding(true);
      gate.resume();
      if (process.stdin.isTTY) process.stdin.setRawMode?.(true);
      if (instance) {
        instance.rerender(element);
        forceRepaint(gate);
      }
    }
  });

  let resolve: (code: number) => void;
  const promise = new Promise<number>((r) => {
    resolve = r;
    instance = render(element, {
      stdin: installed.stdin,
      stdout: gate.stream,
      exitOnCtrlC: false,
      kittyKeyboard: { mode: "enabled", flags: ["disambiguateEscapeCodes"] },
      incrementalRendering: true,
    });
  });

  const restore = () => {
    restoreHost();
    restoreLogs();
    installed.teardown();
    fullScreen.restore();
    process.stdout.write(KITTY_POP);
  };
  const cleanupSignal = installSignalExit(restore);

  try {
    const code = await promise;
    restore();
    cleanupSignal();
    if (noticeMessage) {
      console.log(noticeMessage);
    }
    return code;
  } catch (err) {
    restore();
    cleanupSignal();
    console.error(err);
    return 1;
  }
}
