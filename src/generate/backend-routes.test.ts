import { describe, expect, it } from 'vitest';
import { endpointsFor, extractRoutes } from './backend-routes.js';

const trackingApi = `
import { Router } from 'express';
export const router = Router();
router.post("/track", (req, res) => { res.json({}); });
router.get('/events', (req, res) => { res.json([]); });
router.get('/events', (req, res) => { res.json([]); });
router.delete(\`/events/:id\`, (req, res) => { res.end(); });
router.use(express.json());
`;

describe('extractRoutes', () => {
  it('reads each literal router route once, with its method', () => {
    expect(extractRoutes(trackingApi)).toEqual([
      { method: 'POST', path: '/track' },
      { method: 'GET', path: '/events' },
      { method: 'DELETE', path: '/events/:id' },
    ]);
  });
});

describe('endpointsFor', () => {
  it('prefixes every route with the mount path', () => {
    expect(endpointsFor('/api/tracking-api', trackingApi)).toEqual([
      'POST /api/tracking-api/track',
      'GET /api/tracking-api/events',
      'DELETE /api/tracking-api/events/:id',
    ]);
  });

  it("maps a root route to the mount path's trailing slash", () => {
    expect(endpointsFor('/api/x', "router.get('/', h);")).toEqual(['GET /api/x/']);
  });

  it('falls back to the bare mount path when no file or no literal routes exist', () => {
    expect(endpointsFor('/api/x', undefined)).toEqual(['/api/x']);
    expect(endpointsFor('/api/x', 'router.get(pathVariable, h);')).toEqual(['/api/x']);
  });
});
