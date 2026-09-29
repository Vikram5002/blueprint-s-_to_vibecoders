import { describe, expect, it } from 'vitest';
import { extractEndpoints, extractTables } from './project-facts.js';

const INDEX = [
  "import express from 'express';",
  "import { router as quizApi } from './routes/quiz-api';",
  "import { router as ordersApi } from './routes/orders-api.js';",
  'const app = express();',
  "app.use('/api/quiz-api', quizApi);",
  "app.use('/api/orders-api/', ordersApi);",
].join('\n');

const QUIZ = [
  "router.get('/', (req, res) => res.json([]));",
  "router.post('/answers', (req, res) => res.status(201).end());",
].join('\n');

describe('extractEndpoints', () => {
  it('lists each route of each mounted router with its full path and file', () => {
    const endpoints = extractEndpoints([
      { path: 'backend/src/index.ts', contents: INDEX },
      { path: 'backend/src/routes/quiz-api.ts', contents: QUIZ },
      { path: 'backend/src/routes/orders-api.ts', contents: "router.delete('/:id', h);" },
    ]);
    expect(endpoints).toEqual([
      { method: 'GET', path: '/api/quiz-api', file: 'backend/src/routes/quiz-api.ts' },
      { method: 'POST', path: '/api/quiz-api/answers', file: 'backend/src/routes/quiz-api.ts' },
      { method: 'DELETE', path: '/api/orders-api/:id', file: 'backend/src/routes/orders-api.ts' },
    ]);
  });

  it('lists nothing for a router that is imported but never mounted, or a project without a backend', () => {
    const unmounted = INDEX.split('\n').filter((line) => !line.startsWith('app.use')).join('\n');
    expect(extractEndpoints([{ path: 'backend/src/index.ts', contents: unmounted }, { path: 'backend/src/routes/quiz-api.ts', contents: QUIZ }])).toEqual([]);
    expect(extractEndpoints([{ path: 'frontend/src/main.tsx', contents: '' }])).toEqual([]);
  });
});

describe('extractTables', () => {
  it('reads columns, a composite primary key, and survives nested parentheses', () => {
    const source = [
      'db.exec(`',
      '  CREATE TABLE IF NOT EXISTS results (',
      '    studentId INTEGER NOT NULL,',
      '    questionId INTEGER,',
      "    createdAt TEXT DEFAULT (datetime('now')),",
      '    PRIMARY KEY (studentId, questionId)',
      '  )',
      '`);',
    ].join('\n');
    const [table] = extractTables([{ path: 'backend/src/db/results-table.ts', contents: source }]);
    expect(table?.name).toBe('results');
    expect(table?.file).toBe('backend/src/db/results-table.ts');
    expect(table?.columns).toEqual([
      { name: 'studentId', type: 'INTEGER', primaryKey: true, notNull: true },
      { name: 'questionId', type: 'INTEGER', primaryKey: true, notNull: false },
      { name: 'createdAt', type: 'TEXT', primaryKey: false, notNull: false },
    ]);
  });

  it('records inline and table-level foreign keys', () => {
    const source = [
      'CREATE TABLE orders (id INTEGER PRIMARY KEY, customerId INTEGER REFERENCES customers(id), itemId INTEGER,',
      '  FOREIGN KEY (itemId) REFERENCES items(id));',
    ].join('\n');
    const [table] = extractTables([{ path: 'backend/src/db/orders.ts', contents: source }]);
    expect(table?.columns.find((column) => column.name === 'id')?.primaryKey).toBe(true);
    expect(table?.references).toEqual([
      { column: 'customerId', table: 'customers' },
      { column: 'itemId', table: 'items' },
    ]);
  });

  it('ignores tables outside the backend and lists a table created twice only once', () => {
    const create = 'CREATE TABLE notes (id INTEGER)';
    expect(extractTables([{ path: 'frontend/src/pages/a.tsx', contents: create }])).toEqual([]);
    expect(
      extractTables([
        { path: 'backend/src/db/a.ts', contents: create },
        { path: 'backend/src/db/b.ts', contents: create },
      ]),
    ).toHaveLength(1);
  });
});
