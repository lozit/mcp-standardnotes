import { redact, redactString } from "./redact.js";

type Level = "debug" | "info" | "warn" | "error";

function write(level: Level, msg: string, meta?: unknown): void {
  const line =
    meta === undefined
      ? `[${level}] ${redactString(msg)}`
      : `[${level}] ${redactString(msg)} ${JSON.stringify(redact(meta))}`;
  process.stderr.write(line + "\n");
}

export const logger = {
  debug: (msg: string, meta?: unknown) => {
    if (process.env.DEBUG) write("debug", msg, meta);
  },
  info: (msg: string, meta?: unknown) => write("info", msg, meta),
  warn: (msg: string, meta?: unknown) => write("warn", msg, meta),
  error: (msg: string, meta?: unknown) => write("error", msg, meta),
};
