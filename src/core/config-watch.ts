import { watch, type FSWatcher } from "fs";
import { basename, dirname } from "path";
import { loadConfig } from "../config/schema.js";
import { CONFIG_PATH } from "../config/paths.js";
import type { WuConfig } from "../config/schema.js";
import { createChildLogger } from "../config/logger.js";

const logger = createChildLogger("config-watch");

// Watch the config file for edits and hand the reloaded config back. The
// daemon uses this to pick up `wu config allow` (and any other config write -
// manual edit, remote sync push) without a restart. We watch the containing
// directory rather than the file itself so an atomic rename-replace (what most
// editors do on save) still fires, and coalesce the burst of events a single
// save can emit behind a short debounce.
export function watchConfig(
  onChange: (config: WuConfig) => void,
  opts: { path?: string; debounceMs?: number } = {}
): () => void {
  const configPath = opts.path ?? CONFIG_PATH;
  const debounceMs = opts.debounceMs ?? 300;
  const dir = dirname(configPath);
  const name = basename(configPath);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let watcher: FSWatcher | undefined;

  const reload = () => {
    timer = undefined;
    let next: WuConfig;
    try {
      next = loadConfig(configPath);
    } catch (err) {
      // A read that lands mid-write can yield a partial/invalid file; keep the
      // last-good config and wait for the next event rather than crashing.
      logger.warn({ err: (err as Error).message }, "config reload skipped (unreadable)");
      return;
    }
    onChange(next);
  };

  try {
    watcher = watch(dir, (_event, changed) => {
      // fs.watch may report a null filename on some platforms; when it does,
      // fall through and reload rather than miss the change.
      if (changed && changed !== name) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(reload, debounceMs);
    });
    watcher.on("error", (err) => {
      logger.warn({ err: err.message }, "config watcher error");
    });
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "config watch unavailable");
  }

  return () => {
    if (timer) clearTimeout(timer);
    watcher?.close();
  };
}
