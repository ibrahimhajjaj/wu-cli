import pino from "pino";
import { loadConfig } from "./schema.js";

let _logger: pino.Logger | undefined;

export function getLogger(): pino.Logger {
  if (!_logger) {
    const config = loadConfig();
    _logger = pino({
      level: config.log.level,
      transport:
        process.env.NODE_ENV !== "production"
          ? { target: "pino/file", options: { destination: 2 } }
          : undefined,
    });
  }
  return _logger;
}

export function createChildLogger(name: string): pino.Logger {
  return getLogger().child({ module: name });
}
