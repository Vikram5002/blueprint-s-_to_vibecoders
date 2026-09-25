/**
 * The project the analysis routes currently answer about.
 *
 * The server used to capture one `AnalysisContext` for its whole lifetime -
 * the repository the CLI was started in. Analysing another project from the
 * UI (a local folder, or a cloned Git repository) needs that to be
 * replaceable while the server stays up, so every analysis route reads
 * `current()` on each request instead of closing over a fixed value.
 *
 * Only the analysis routes follow the holder. The workspace (sessions,
 * provider settings, generated applications) stays bound to the database of
 * the repository the server was started in - switching the project being
 * measured must never move or hide the user's own work.
 */
import type { AnalysisContext } from './context.js';

export interface ContextHolder {
  current(): AnalysisContext;
  /**
   * Swaps the project. The previous project's database handle is closed unless
   * it is the home project's, which the workspace routes keep using.
   */
  replace(next: AnalysisContext): void;
  /** The repository the server was started in - never closed by a swap. */
  readonly home: AnalysisContext;
}

export function createContextHolder(home: AnalysisContext): ContextHolder {
  let active = home;
  return {
    home,
    current: () => active,
    replace: (next) => {
      const previous = active;
      active = next;
      if (previous !== home && previous.db !== next.db) previous.db.close();
    },
  };
}
