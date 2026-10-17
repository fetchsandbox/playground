// Structured JSON logs — CloudWatch Logs Insights can filter on any field.
export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export function createLogger(base: Record<string, unknown> = {}, sink: (line: string) => void = console.log): Logger {
  const emit = (level: string, msg: string, fields?: Record<string, unknown>) =>
    sink(JSON.stringify({ level, msg, ...base, ...fields, at: new Date().toISOString() }));
  return {
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    child: (f) => createLogger({ ...base, ...f }, sink),
  };
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {}, child: () => silentLogger };
