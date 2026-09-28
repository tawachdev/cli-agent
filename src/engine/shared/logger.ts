export type LogLevel = "debug" | "info" | "warn" | "error";

const levelWeights: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function createLogger(
  minLevel: LogLevel,
  sink: (line: string) => void = (line) => console.log(line),
): Logger {
  const emit = (level: LogLevel, msg: string, fields?: Record<string, unknown>): void => {
    if (levelWeights[level] < levelWeights[minLevel]) return;
    sink(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }));
  };
  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
  };
}
