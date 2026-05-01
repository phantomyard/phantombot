/**
 * Tiny structured logger. Writes JSON lines to stdout.
 *
 * Replace with pino / winston / etc. if you outgrow this. The interface here
 * is intentionally narrow so the swap stays small.
 */

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const minLevel: LogLevel = (process.env.PHANTOMBOT_LOG_LEVEL as LogLevel) ?? "info";

function emit(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
  if (LEVELS[level] < LEVELS[minLevel]) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(fields ?? {}),
  };
  // stderr for warn/error so log shippers can split if desired.
  const stream = level === "warn" || level === "error" ? process.stderr : process.stdout;
  stream.write(JSON.stringify(line) + "\n");
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
};
