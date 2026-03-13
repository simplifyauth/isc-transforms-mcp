export type Logger = {
  debug: (...a: any[]) => void;
  info: (...a: any[]) => void;
  warn: (...a: any[]) => void;
  error: (...a: any[]) => void;
};

export function createLogger(enabledDebug: boolean): Logger {
  const prefix = "[isc-mcp]";
  return {
    debug: (...a) => enabledDebug && console.error(prefix, "[debug]", ...a),
    info: (...a) => console.error(prefix, "[info]", ...a),
    warn: (...a) => console.error(prefix, "[warn]", ...a),
    error: (...a) => console.error(prefix, "[error]", ...a)
  };
}