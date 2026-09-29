import { describe, expect, it } from 'vitest';
import { filterCommands, withHeadings, type Command } from './command-palette';

const command = (id: string, group: string, label: string, keywords?: string): Command => ({
  id,
  group,
  label,
  icon: 'bolt',
  ...(keywords === undefined ? {} : { keywords }),
  run: () => {},
});

const COMMANDS = [
  command('new', 'Actions', 'New project', 'create start'),
  command('workflow', 'Go to', 'Workflow', 'graph plan'),
  command('fest', 'Projects', 'Open Campus Fest'),
  command('quiz', 'Projects', 'Open Quiz Website'),
];

describe('filterCommands', () => {
  it('returns everything for an empty query, in order', () => {
    expect(filterCommands(COMMANDS, '  ').map((c) => c.id)).toEqual(['new', 'workflow', 'fest', 'quiz']);
  });

  it('matches every typed word in any order and case, including keywords and the group', () => {
    expect(filterCommands(COMMANDS, 'FEST open').map((c) => c.id)).toEqual(['fest']);
    expect(filterCommands(COMMANDS, 'graph').map((c) => c.id)).toEqual(['workflow']);
    expect(filterCommands(COMMANDS, 'projects').map((c) => c.id)).toEqual(['fest', 'quiz']);
    expect(filterCommands(COMMANDS, 'nothing like this')).toEqual([]);
  });
});

describe('withHeadings', () => {
  it('puts each group heading once, above its first command, and keeps each command index', () => {
    const rows = withHeadings(filterCommands(COMMANDS, 'o'));
    expect(rows.map((row) => ('heading' in row ? `# ${row.heading}` : row.command.id))).toEqual([
      '# Actions',
      'new',
      '# Go to',
      'workflow',
      '# Projects',
      'fest',
      'quiz',
    ]);
    expect(rows.filter((row) => 'command' in row).map((row) => ('command' in row ? row.index : -1))).toEqual([0, 1, 2, 3]);
  });
});
