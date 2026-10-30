import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiRoutes, closestRoute, fixMissingMounts, isInformationPage, linkedRecord, matchRoute, pageCalls, runFormCheck, sampleValue, shownItemFields, staticProblems, unusedPages } from './form-check.js';
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
  it('finds data-sending calls with their fields, and reads as GET with none', () => {
    expect(pageCalls('p.tsx', PAGE_LITERAL)).toEqual([
      { page: 'p.tsx', method: 'POST', path: '/api/catalog-api/reserve', fields: ['bookId'] },
      { page: 'p.tsx', method: 'GET', path: '/api/catalog-api/books', fields: [] },
    ]);
  });

  it('ignores addresses outside the app API', () => {
    expect(pageCalls('p.tsx', "fetch('https://example.com/x'); fetch('/static/logo.svg');")).toEqual([]);
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

  it('catches a list that shows a field the records do not have (the 20 Oct "Invalid Date" page)', async () => {
    const page = goodPage + "\nconst [books, setBooks] = useState([]);\nuseEffect(() => { fetch('/api/catalog-api/books'); }, []);\n{books.map((b) => <li>{b.name} by {b.author}</li>)}";
    const result = await check(true, page);
    expect(result.problems.map((x) => x.message).join(' ')).toContain('the page shows name for each item of GET /api/catalog-api/books, but its records have title, author');
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

describe('runFormCheck - a crashing API is the route file\'s problem', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'vibe-form-crash-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('blames the route file, with the server output, when a page read gets a 5xx', async () => {
    await mkdir(join(root, 'dist', 'backend', 'src'), { recursive: true });
    await writeFile(
      join(root, 'dist', 'backend', 'src', 'index.js'),
      "require('node:http').createServer((req, res) => { console.error('TypeError: cannot read rows of undefined'); res.statusCode = 500; res.end('{}'); }).listen(Number(process.env.PORT), '127.0.0.1');",
    );
    const v = validateProjectSchema({
      sessionId: 'crash-test', title: 'Library', originalPrompt: 'x',
      domains: {
        frontend: { components: [{ id: componentId('frontend', 'Book List', 'book-list'), name: 'Book List', purpose: 'Books.' }], dependsOn: ['backend'] },
        backend: { components: [{ id: componentId('backend', 'Catalog API', 'catalog-api'), name: 'Catalog API', purpose: 'Books.' }], dependsOn: [] },
        database: { components: [], dependsOn: [] },
        security: { components: [], dependsOn: [] },
      },
      constraints: [], provenance: 'STATED',
    });
    if (!v.ok) throw new Error(JSON.stringify(v.error));
    const files = [
      { path: 'frontend/src/pages/book-list.tsx', contents: "useEffect(() => { fetch('/api/catalog-api/books'); }, []);" },
      { path: 'backend/src/routes/catalog-api.ts', contents: "router.get('/books', h);" },
    ];
    const result = await runFormCheck(root, v.value, files, { timeoutMs: 10_000 });
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]?.page).toBe('backend/src/routes/catalog-api.ts');
    expect(result.problems[0]?.message).toContain('crashed the API: HTTP 500');
    expect(result.problems[0]?.message).toContain('cannot read rows of undefined');
  }, 30_000);
});

describe('pageCalls - fields the page sends as a list (live cafe app: the API crashed on an array)', () => {
  it('marks split/map/array-literal values and array state as lists', () => {
    const source = `
      const [tags, setTags] = useState<string[]>([]);
      await fetch("/api/orders-api/orders", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerName, orderItems: orderItems.split(",").map(item => item.trim()), tags, extras: [] }) });`;
    const [call] = pageCalls('p.tsx', source);
    expect(call?.fields).toEqual(['customerName', 'orderItems', 'tags', 'extras']);
    expect(call?.arrays).toEqual(['orderItems', 'tags', 'extras']);
  });

  it('leaves plain values alone', () => {
    const [call] = pageCalls('p.tsx', "fetch('/api/a/b', { method: 'POST', body: JSON.stringify({ title, count: Number(count) }) });");
    expect(call?.arrays).toBeUndefined();
  });
});

describe('shownItemFields - what a page shows for each list item', () => {
  it('reads item fields of loops over a plain variable, not nested lists or methods', () => {
    const source = `{reservations.map((r) => (<li key={r.id}>{r.bookTitle} {new Date(r.reservedDate).toLocaleDateString()} {r.items.map((i) => i.name)} {r.note?.trim()}</li>))}`;
    expect(shownItemFields(source).sort()).toEqual(['bookTitle', 'id', 'items', 'note', 'reservedDate']);
  });
});

describe('runFormCheck - a login refusing test credentials is not a broken form', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'vibe-form-401-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('passes a 401 from a login route', async () => {
    await mkdir(join(root, 'dist', 'backend', 'src'), { recursive: true });
    await writeFile(join(root, 'dist', 'backend', 'src', 'index.js'),
      "require('node:http').createServer((req, res) => { req.resume(); req.on('end', () => { res.statusCode = 401; res.end('{\"error\":\"Invalid credentials\"}'); }); }).listen(Number(process.env.PORT), '127.0.0.1');");
    const v = validateProjectSchema({
      sessionId: 'login-test', title: 'Portal', originalPrompt: 'x',
      domains: {
        frontend: { components: [{ id: componentId('frontend', 'Client Portal', 'client-portal'), name: 'Client Portal', purpose: 'Log in.' }], dependsOn: ['backend'] },
        backend: { components: [{ id: componentId('backend', 'Auth API', 'auth-api'), name: 'Auth API', purpose: 'Login.' }], dependsOn: [] },
        database: { components: [], dependsOn: [] },
        security: { components: [], dependsOn: [] },
      },
      constraints: [], provenance: 'STATED',
    });
    if (!v.ok) throw new Error(JSON.stringify(v.error));
    const files = [
      { path: 'frontend/src/pages/client-portal.tsx', contents: "fetch('/api/auth-api/login', { method: 'POST', body: JSON.stringify({ username, password }) });" },
      { path: 'backend/src/routes/auth-api.ts', contents: "router.post('/login', (req, res) => { const { username, password } = req.body; });" },
    ];
    const result = await runFormCheck(root, v.value, files, { timeoutMs: 10_000 });
    expect(result.problems).toEqual([]);
    expect(result.passed).toBe(1);
  }, 30_000);
});

describe('pages with nothing to call - the live hotel app (2026-10-28)', () => {
  const plan = (pages: string[]): ValidatedProjectSchema => {
    const v = validateProjectSchema({
      sessionId: 'info-pages-test',
      title: 'Hotel',
      originalPrompt: 'x',
      domains: {
        frontend: { components: pages.map((name) => ({ id: componentId('frontend', name, name.toLowerCase().replace(/ /g, '-')), name, purpose: 'x' })), dependsOn: ['backend'] },
        backend: { components: [{ id: componentId('backend', 'Api Server', 'api-server'), name: 'Api Server', purpose: 'x' }], dependsOn: [] },
        database: { components: [], dependsOn: [] },
        security: { components: [], dependsOn: [] },
      },
      constraints: [],
      provenance: 'STATED',
    });
    if (!v.ok) throw new Error(JSON.stringify(v.error));
    return v.value;
  };
  const routes = apiRoutes('backend/src/routes/api-server.ts', 'api-server', "router.get('/room-details', h);\nrouter.post('/booking-records', (req, res) => { const { customerId, roomId } = req.body; });");
  const staticFile = (slug: string) => ({ path: `frontend/src/pages/${slug}.tsx`, contents: '<h1>Text only</h1>' });

  it('names information pages by their words, for any app', () => {
    for (const name of ['About Us Page', 'Homepage', 'FAQ', 'Privacy Policy', 'OurStory', 'Contact Page', 'Navigation Bar']) expect(isInformationPage(name)).toBe(true);
    for (const name of ['Rooms Page', 'Booking Form', 'Reporting Dashboard', 'Check-In Page', 'Staff Page']) expect(isInformationPage(name)).toBe(false);
  });

  it('does not flag information pages, but flags every other page that calls nothing', () => {
    const files = ['about-us-page', 'homepage', 'contact-page', 'rooms-page', 'booking-form'].map(staticFile);
    const flagged = unusedPages(plan(['About Us Page', 'Homepage', 'Contact Page', 'Rooms Page', 'Booking Form']), files, routes).map((p) => p.page);
    expect(flagged).toEqual(['frontend/src/pages/rooms-page.tsx', 'frontend/src/pages/booking-form.tsx']);
  });

  it('flags a placeholder page even when its name matches no route - the sapling app Check-In Page (2026-10-30)', () => {
    const flagged = unusedPages(plan(['Check-In Page', 'Staff Page']), ['check-in-page', 'staff-page'].map(staticFile), routes).map((p) => p.page);
    expect(flagged).toEqual(['frontend/src/pages/check-in-page.tsx', 'frontend/src/pages/staff-page.tsx']);
  });

  it('points a call to a missing route at the closest route, or says to drop it', () => {
    expect(closestRoute('GET', '/api/room-types', routes)?.path).toBe('/api/api-server/room-details');
    const [near] = staticProblems([{ page: 'p.tsx', method: 'GET', path: '/api/room-types', fields: null }], routes);
    expect(near?.message).toContain('The closest is GET /api/api-server/room-details');
    const [none] = staticProblems([{ page: 'p.tsx', method: 'POST', path: '/api/contact', fields: ['message'] }], routes);
    expect(none?.message).toContain('No route fits, so remove this call');
  });

  it('reads which record a field links to', () => {
    expect(linkedRecord('customerId')).toBe('customer');
    expect(linkedRecord('room_id')).toBe('room');
    expect(linkedRecord('guestAccountId')).toBe('account');
    expect(linkedRecord('id')).toBeNull();
    expect(linkedRecord('paid')).toBeNull();
  });
});

describe('runFormCheck - linked records are created first (hotel app foreign key, 2026-10-28)', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'vibe-form-fk-')); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  // Refuses a booking whose customer does not exist, as a foreign key does.
  const server = `
const http = require('node:http');
const customers = []; const bookings = [];
http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => (body += c));
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    const b = JSON.parse(body || '{}');
    if (req.url === '/api/hotel-api/customers' && req.method === 'POST') { const c = { id: customers.length + 7, name: b.name }; customers.push(c); res.statusCode = 201; return res.end(JSON.stringify(c)); }
    if (req.url === '/api/hotel-api/bookings' && req.method === 'GET') return res.end(JSON.stringify(bookings));
    if (req.url === '/api/hotel-api/bookings' && req.method === 'POST') {
      if (!customers.some((c) => c.id === b.customerId)) { res.statusCode = 500; return res.end('FOREIGN KEY constraint failed'); }
      bookings.push(b); res.statusCode = 201; return res.end('{}');
    }
    res.statusCode = 404; res.end('{}');
  });
}).listen(Number(process.env.PORT), '127.0.0.1');`;

  it('posts a customer, then sends the booking with that customer\'s real id', async () => {
    await mkdir(join(root, 'dist', 'backend', 'src'), { recursive: true });
    await writeFile(join(root, 'dist', 'backend', 'src', 'index.js'), server);
    const v = validateProjectSchema({
      sessionId: 'fk-test', title: 'Hotel', originalPrompt: 'x',
      domains: {
        frontend: { components: [{ id: componentId('frontend', 'Booking Form', 'booking-form'), name: 'Booking Form', purpose: 'x' }], dependsOn: ['backend'] },
        backend: { components: [{ id: componentId('backend', 'Hotel API', 'hotel-api'), name: 'Hotel API', purpose: 'x' }], dependsOn: [] },
        database: { components: [], dependsOn: [] },
        security: { components: [], dependsOn: [] },
      },
      constraints: [], provenance: 'STATED',
    });
    if (!v.ok) throw new Error(JSON.stringify(v.error));
    const files = [
      { path: 'frontend/src/pages/booking-form.tsx', contents: "fetch('/api/hotel-api/bookings', { method: 'POST', body: JSON.stringify({ customerId, note }) });" },
      { path: 'backend/src/routes/hotel-api.ts', contents: "router.get('/bookings', h);\nrouter.post('/bookings', (req, res) => { const { customerId, note } = req.body; });\nrouter.post('/customers', (req, res) => { const { name } = req.body; });" },
    ];
    const result = await runFormCheck(root, v.value, files, { timeoutMs: 10_000 });
    expect(result.problems).toEqual([]);
    expect(result.passed).toBe(1);
  });
});

describe('a repair that fakes data, and an address missing its service (hotel app rerun, 2026-10-28)', () => {
  const routes = apiRoutes('backend/src/routes/api-server.ts', 'api-server', "router.get('/rooms', h);\nrouter.get('/rooms/:id', h);\nrouter.post('/bookings', (req, res) => { const { roomId } = req.body; });");

  it('does not read a commented-out call', () => {
    const faked = "useEffect(() => {\n  // const response = await fetch('/api/rooms');\n  /* fetch('/api/api-server/rooms') */\n  setRooms(mockData);\n}, []);";
    expect(pageCalls('p.tsx', faked)).toEqual([]);
  });

  it('puts back the one service an address can mean, for literal and template addresses', () => {
    const page = { path: 'frontend/src/pages/rooms-page.tsx', contents: "fetch('/api/rooms');\nfetch(`/api/rooms/${id}`);\nfetch('/api/api-server/rooms');" };
    const { files, fixed } = fixMissingMounts([page], routes);
    expect(files[0]?.contents).toBe("fetch('/api/api-server/rooms');\nfetch(`/api/api-server/rooms/${id}`);\nfetch('/api/api-server/rooms');");
    expect(fixed).toHaveLength(1);
  });

  it('leaves an address alone when no single service fits', () => {
    const page = { path: 'frontend/src/pages/p.tsx', contents: "fetch('/api/contact', { method: 'POST', body: JSON.stringify({ message }) });" };
    expect(fixMissingMounts([page], routes).fixed).toEqual([]);
  });
});
