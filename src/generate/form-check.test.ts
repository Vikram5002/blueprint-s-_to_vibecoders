import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiRoutes, matchRoute, pageCalls, runFormCheck, sampleValue, staticProblems, unusedPages } from './form-check.js';
import { componentId, type ValidatedProjectSchema } from '../types/project-schema.js';
import { validateProjectSchema } from '../workflow/validate-project-schema.js';

const PAGE_LITERAL = `
export function ReserveButton({ bookId }: { bookId: number }) {
  async function reserve(): Promise<void> {
    await fetch(\`/api/catalog-api/reserve\`, { method: "POST", headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bookId }) });
  }
  const list = fetch('/api/catalog-api/books');
  return null;
}`;

const PAGE_STATE = `
export function BookForm() {
  const [form, setForm] = useState<{ title: string; author: string }>({ title: '', author: '' });
  const save = () => fetch('/api/catalog-api/books', { method: 'POST', body: JSON.stringify(form) });
  const update = (id: number) => fetch(\`/api/catalog-api/books/\${id}\`, { method: 'PUT', body: JSON.stringify({ ...form, copies: 2 }) });
  return null;
}`;

const ROUTER = `
const router = Router();
router.get('/books', (req, res) => res.json(listBooks()));
router.post('/books', (req, res) => { const { title, author } = req.body; res.status(201).json(insertBook({ title, author })); });
router.put('/books/:id', (req, res) => { updateBook(Number(req.params.id), { title: req.body.title, author: req.body.author, copies: req.body.copies }); res.json({}); });
router.post('/reservations', (req, res) => { const { book_id, user_id = 1 } = req.body; res.status(201).json({ book_id, user_id }); });
export default router;`;

describe('reading pages and routers', () => {
  it('finds data-sending calls with literal bodies and skips plain reads', () => {
    expect(pageCalls('p.tsx', PAGE_LITERAL)).toEqual([{ page: 'p.tsx', method: 'POST', path: '/api/catalog-api/reserve', fields: ['bookId'] }]);
  });

  it('reads a state object body, spreads included, and fills ${} parts of the address', () => {
    expect(pageCalls('p.tsx', PAGE_STATE).map((c) => [c.method, c.path, c.fields])).toEqual([
      ['POST', '/api/catalog-api/books', ['title', 'author']],
      ['PUT', '/api/catalog-api/books/1', ['title', 'author', 'copies']],
    ]);
  });

  it('reads routes under the mount point with the body fields each handler reads', () => {
    expect(apiRoutes('r.ts', 'catalog-api', ROUTER).map((r) => [r.method, r.path, r.fields])).toEqual([
      ['GET', '/api/catalog-api/books', []],
      ['POST', '/api/catalog-api/books', ['title', 'author']],
      ['PUT', '/api/catalog-api/books/:id', ['title', 'author', 'copies']],
      ['POST', '/api/catalog-api/reservations', ['book_id', 'user_id']],
    ]);
  });
});

describe('staticProblems - the live library-app mismatch', () => {
  const routes = apiRoutes('r.ts', 'catalog-api', ROUTER);

  it('reports a call to a route the API does not have, listing what it does offer', () => {
    const [problem] = staticProblems(pageCalls('p.tsx', PAGE_LITERAL), routes);
    expect(problem?.message).toContain('has no such route');
    expect(problem?.message).toContain('POST /api/catalog-api/reservations (reads book_id, user_id)');
  });

  it('reports fields the route reads that the page does not send', () => {
    const call = { page: 'p.tsx', method: 'POST', path: '/api/catalog-api/reservations', fields: ['bookId'] };
    expect(matchRoute(call, routes)?.path).toBe('/api/catalog-api/reservations');
    expect(staticProblems([call], routes)[0]?.message).toContain('missing book_id, user_id');
  });

  it('passes a call that matches a :param route and sends every field', () => {
    expect(staticProblems(pageCalls('p.tsx', PAGE_STATE), routes)).toEqual([]);
  });
});

describe('sampleValue', () => {
  it('picks plain values from field names', () => {
    expect(sampleValue('book_id')).toBe(1);
    expect(sampleValue('party_size')).toBe(1);
    expect(sampleValue('email')).toBe('test@example.com');
    expect(sampleValue('booking_date')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(sampleValue('title')).toBe('Check title');
    expect(sampleValue('message')).toBe('Check message');
    expect(sampleValue('format')).toBe('Check format');
    expect(sampleValue('createdAt')).toMatch(/^\d{4}-/);
    expect(sampleValue('bookId')).toBe(1);
  });
});

/** A built backend that stores books in memory; `storeAuthor: false` plants a value that is accepted but never saved. */
function fakeServer(storeAuthor: boolean): string {
  return `
const http = require('node:http');
const books = [];
http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/catalog-api/books' && req.method === 'GET') return res.end(JSON.stringify(books));
    if (req.url === '/api/catalog-api/books' && req.method === 'POST') {
      const { title, author } = JSON.parse(body || '{}');
      if (!title) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'title is required' })); }
      books.push(${storeAuthor ? '{ title, author }' : '{ title }'});
      res.statusCode = 201; return res.end('{}');
    }
    res.statusCode = 404; res.end('{}');
  });
}).listen(Number(process.env.PORT), '127.0.0.1');`;
}

describe('runFormCheck - live, against a real running server', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'vibe-form-check-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function schema(): ValidatedProjectSchema {
    const v = validateProjectSchema({
      sessionId: 'form-check-test',
      title: 'Library',
      originalPrompt: 'x',
      domains: {
        frontend: { components: [{ id: componentId('frontend', 'Book Form', 'book-form'), name: 'Book Form', purpose: 'Add books.' }], dependsOn: ['backend'] },
        backend: { components: [{ id: componentId('backend', 'Catalog API', 'catalog-api'), name: 'Catalog API', purpose: 'Books.' }], dependsOn: [] },
        database: { components: [], dependsOn: [] },
        security: { components: [], dependsOn: [] },
      },
      constraints: [],
      provenance: 'STATED',
    });
    if (!v.ok) throw new Error(JSON.stringify(v.error));
    return v.value;
  }

  async function check(storeAuthor: boolean, page: string) {
    await mkdir(join(root, 'dist', 'backend', 'src'), { recursive: true });
    await writeFile(join(root, 'dist', 'backend', 'src', 'index.js'), fakeServer(storeAuthor));
    const files = [
      { path: 'frontend/src/pages/book-form.tsx', contents: page },
      { path: 'backend/src/routes/catalog-api.ts', contents: "router.get('/books', h);\nrouter.post('/books', (req, res) => { const { title, author } = req.body; });" },
    ];
    return runFormCheck(root, schema(), files, { timeoutMs: 10_000 });
  }

  const goodPage = "const [form, setForm] = useState({ title: '', author: '' });\nfetch('/api/catalog-api/books', { method: 'POST', body: JSON.stringify(form) });";

  it('passes a page whose form the API accepts and stores', async () => {
    const result = await check(true, goodPage);
    expect(result.problems).toEqual([]);
    expect(result.passed).toBe(1);
  }, 30_000);

  it('catches a value the API accepts but never saves', async () => {
    const result = await check(false, goodPage);
    expect(result.problems[0]?.message).toContain('does not show author');
  }, 30_000);

  it('catches a page that renamed a field the route reads, without starting anything', async () => {
    const result = await check(true, "fetch('/api/catalog-api/books', { method: 'POST', body: JSON.stringify({ name: 'x', author: 'y' }) });");
    expect(result.problems[0]?.message).toContain('missing title');
    expect(result.passed).toBe(0);
  }, 30_000);
});

describe('unusedPages - the live finance-app placeholders', () => {
  const plan = (dependsOn: string[]): ValidatedProjectSchema => {
    const v = validateProjectSchema({
      sessionId: 'unused-pages-test',
      title: 'Finance',
      originalPrompt: 'x',
      domains: {
        frontend: { components: [{ id: componentId('frontend', 'Reporting Dashboard', 'reporting-dashboard'), name: 'Reporting Dashboard', purpose: 'Reports.' }], dependsOn },
        backend: { components: [{ id: componentId('backend', 'Reporting Service', 'reporting-service'), name: 'Reporting Service', purpose: 'Reports.' }], dependsOn: [] },
        database: { components: [], dependsOn: [] },
        security: { components: [], dependsOn: [] },
      },
      constraints: [],
      provenance: 'STATED',
    });
    if (!v.ok) throw new Error(JSON.stringify(v.error));
    return v.value;
  };
  const routerSource = ["router.get('/reports', h);", "router.post('/reports', (req, res) => { const { title, period } = req.body; });"].join('\n');
  const routes = apiRoutes('backend/src/routes/reporting-service.ts', 'reporting-service', routerSource);
  const page = (contents: string) => [{ path: 'frontend/src/pages/reporting-dashboard.tsx', contents }];

  it('flags a page that calls no API, listing every route and the fields to send', () => {
    const [problem] = unusedPages(plan(['backend']), page('export function ReportingDashboard() { return <h1>Reports</h1>; }'), routes);
    expect(problem?.message).toContain('calls no API route');
    expect(problem?.message).toContain('GET /api/reporting-service/reports');
    expect(problem?.message).toContain('POST /api/reporting-service/reports (reads title, period)');
  });

  it('flags it even when the plan leaves out the page -> API link, as the finance plan did', () => {
    expect(unusedPages(plan([]), page('<h1>Reports</h1>'), routes)).toHaveLength(1);
  });

  it('passes a page that uses the API, and any page of an app with no API routes', () => {
    expect(unusedPages(plan(['backend']), page("useEffect(() => { fetch('/api/reporting-service/reports'); }, []);"), routes)).toEqual([]);
    expect(unusedPages(plan([]), page('<h1>Reports</h1>'), [])).toEqual([]);
  });
});
