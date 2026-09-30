/**
 * The command palette's search: which commands match what was typed, in the
 * order they were listed. Every word typed must appear somewhere in the
 * command's label or keywords, in any order and any case - "fest open"
 * finds "Open Campus Fest".
 */
import type { IconName } from '../design/Icon';

export interface Command {
  readonly id: string;
  readonly group: string;
  readonly label: string;
  readonly icon: IconName;
  /** Extra words that should find this command without being shown. */
  readonly keywords?: string;
  /** Right-aligned detail: a date, "not set up". */
  readonly hint?: string;
  readonly run: () => void | Promise<void>;
}

export function filterCommands(commands: readonly Command[], query: string): readonly Command[] {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== '');
  if (words.length === 0) return commands;
  return commands.filter((command) => {
    const haystack = `${command.label} ${command.keywords ?? ''} ${command.group}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

/** Commands in display order, with their group headings - a heading appears once, above its first match. */
export function withHeadings(
  commands: readonly Command[],
): readonly (
  { readonly heading: string } | { readonly command: Command; readonly index: number }
)[] {
  const rows: (
    { readonly heading: string } | { readonly command: Command; readonly index: number }
  )[] = [];
  let lastGroup: string | null = null;
  commands.forEach((command, index) => {
    if (command.group !== lastGroup) {
      rows.push({ heading: command.group });
      lastGroup = command.group;
    }
    rows.push({ command, index });
  });
  return rows;
}
