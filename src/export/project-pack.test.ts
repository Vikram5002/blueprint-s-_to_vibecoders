import { describe, expect, it } from 'vitest';
import { README_MARKER, withProjectPack, type ProjectPackInput } from './project-pack.js';
import type { ZipEntry } from './runnable-project.js';
import type { ProjectSchema } from '../types/project-schema.js';

const component = (name: string, purpose: string) => ({ id: name, name, purpose });

const SCHEMA: ProjectSchema = {
  sessionId: 'session-quiz',
  title: 'Campus Quiz',
  originalPrompt: 'A quiz app where students answer questions and see their results.',
  domains: {
    frontend: { components: [component('Quiz Interface', 'Shows questions and takes answers.')], dependsOn: ['backend'] },
    backend: { components: [component('Quiz API', 'Serves questions and records answers.')], dependsOn: ['database', 'security'] },
    database: { components: [component('Results Table', 'Stores each answer.')], dependsOn: [] },
    security: { components: [], dependsOn: [] },
  },
  constraints: [],
  provenance: 'STATED',
};

const ENTRIES: readonly ZipEntry[] = [
  { path: 'README.md', contents: `# Campus Quiz\n\n${README_MARKER}\n` },
  { path: 'package.json', contents: JSON.stringify({ dependencies: { express: '^4' }, devDependencies: { vite: '^5' } }) },
  { path: 'frontend/src/pages/quiz-interface.tsx', contents: 'export function QuizInterface() { return null; }' },
  { path: 'backend/src/index.ts', contents: "import { router as quizApi } from './routes/quiz-api';\napp.use('/api/quiz-api', quizApi);" },
  { path: 'backend/src/routes/quiz-api.ts', contents: "router.get('/questions', h);\nrouter.post('/answers', h);" },
  { path: 'backend/src/db/results-table.ts', contents: "import { DatabaseSync } from 'node:sqlite';\ndb.exec(`CREATE TABLE results (id INTEGER PRIMARY KEY, answer TEXT NOT NULL)`);" },
];

const INPUT: ProjectPackInput = {
  schema: SCHEMA,
  verification: { buildOk: true, architectureViolations: 0, securityFindings: 0, repairRounds: 1 },
};

const pack = (entries: readonly ZipEntry[] = ENTRIES, input: ProjectPackInput = INPUT): Map<string, string> =>
  new Map(withProjectPack(entries, input).map((entry) => [entry.path, entry.contents]));

describe('withProjectPack', () => {
  it('adds the five documents and links them from the generated README', () => {
    const files = pack();
    for (const path of ['docs/PROJECT-REPORT.md', 'docs/ARCHITECTURE.md', 'docs/API.md', 'docs/VIVA-PREP.md', 'docs/DEPLOY-FREE.md']) {
      expect(files.has(path)).toBe(true);
      expect(files.get('README.md')).toContain(`(${path})`);
    }
  });

  it('fills the report with facts from the plan and the code, and says what the student must write', () => {
    const report = pack().get('docs/PROJECT-REPORT.md') ?? '';
    expect(report).toContain('A quiz app where students answer questions and see their results.');
    expect(report).toContain('| backend | Quiz API | Serves questions and records answers. | `backend/src/routes/quiz-api.ts` |');
    expect(report).toContain('| GET | `/api/quiz-api/questions` | `backend/src/routes/quiz-api.ts` |');
    expect(report).toContain('| answer | TEXT |  | Yes |');
    expect(report).toContain('| Architecture rules (Blueprint import check) | Passed - no violations |');
    expect(report).toContain('| Database | SQLite (built into Node.js 22.5+, node:sqlite) |');
    expect(report).toContain('write the sections marked ✍️ in your own words');
  });

  it('draws the layers and the tables as diagrams', () => {
    const report = pack().get('docs/PROJECT-REPORT.md') ?? '';
    expect(report).toContain('  frontend --> backend');
    expect(report).toContain('  backend --> database');
    expect(report).toContain('erDiagram');
    expect(report).toContain('    INTEGER id PK');
  });

  it('states the rules the build enforces, derived from dependsOn', () => {
    const report = pack().get('docs/PROJECT-REPORT.md') ?? '';
    expect(report).toContain('| Frontend (pages the user sees) | backend | database, security |');
  });

  it('asks viva questions about this project, not generic ones', () => {
    const viva = pack().get('docs/VIVA-PREP.md') ?? '';
    expect(viva).toContain('Why may the frontend layer not use database or security?');
    expect(viva).toContain('What does Results Table do, and where is it implemented?');
    expect(viva).toContain('What happens when a client calls POST /api/quiz-api/answers?');
    expect(viva).toContain('Explain the results table. What is its primary key?');
  });

  it('gives a runnable command for each endpoint', () => {
    const api = pack().get('docs/API.md') ?? '';
    expect(api).toContain('curl -X GET http://localhost:3000/api/quiz-api/questions');
    expect(api).toContain("curl -X POST http://localhost:3000/api/quiz-api/answers -H 'content-type: application/json' -d '{}'");
  });

  it('is deterministic, and never overwrites a document or README the project already has', () => {
    expect([...pack()]).toEqual([...pack()]);
    const own = [...ENTRIES.filter((entry) => entry.path !== 'README.md'), { path: 'README.md', contents: '# mine' }, { path: 'docs/API.md', contents: 'my api notes' }];
    const files = pack(own);
    expect(files.get('docs/API.md')).toBe('my api notes');
    expect(files.get('README.md')).toBe('# mine');
  });

  it('reports honestly when there is no verification result, no tables and no API', () => {
    const frontendOnly = ENTRIES.filter((entry) => !entry.path.startsWith('backend/'));
    const files = pack(frontendOnly, { schema: SCHEMA });
    const report = files.get('docs/PROJECT-REPORT.md') ?? '';
    expect(report).toContain('No verification result was recorded');
    expect(report).toContain('No `CREATE TABLE` statement was found');
    expect(report).toContain('No mounted API routes were found.');
    expect(files.get('docs/DEPLOY-FREE.md')).not.toContain('## 3. The API');
    // A planned module whose file is missing is still listed, without a file.
    expect(report).toContain('| backend | Quiz API | Serves questions and records answers. | - |');
  });
});
