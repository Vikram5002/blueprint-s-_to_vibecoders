import { describe, expect, it } from 'vitest';
import { fallbackDataPage, routeForPage } from './fallback-page.js';
import { apiRoutes, pageCalls, shownItemFields, staticProblems } from './form-check.js';
import { componentId } from '../types/project-schema.js';

const routes = apiRoutes('backend/src/routes/api-server.ts', 'api-server', [
  "router.get('/users', h);",
  "router.get('/rooms', h);",
  "router.get('/rooms/:id', h);",
  "router.post('/rooms', (req, res) => { const { description, price, isAvailable, hotelId } = req.body; });",
].join('\n'));
const component = (name: string) => ({ id: componentId('frontend', name, name.toLowerCase().replace(/ /g, '-')), name, purpose: 'x' });

describe('fallbackDataPage - the hotel Rooms page the repair coder kept faking (2026-10-28)', () => {
  it('picks the list route named for the page, never a :param route', () => {
    expect(routeForPage(component('Rooms Page'), routes)?.path).toBe('/api/api-server/rooms');
    expect(routeForPage(component('Contact Page'), routes)).toBeUndefined();
  });

  it('writes a page whose calls match the API exactly, as the form check reads them', () => {
    const page = fallbackDataPage(component('Rooms Page'), routes);
    expect(page?.path).toBe('frontend/src/pages/rooms-page.tsx');
    const calls = pageCalls(page?.path ?? '', page?.contents ?? '');
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /api/api-server/rooms', 'POST /api/api-server/rooms']);
    expect(calls[1]?.fields).toEqual(['description', 'price', 'isAvailable', 'hotelId']);
    expect(staticProblems(calls, routes)).toEqual([]);
    expect(shownItemFields(page?.contents ?? '')).toEqual([]);
  });

  it('gives each field an input of the right kind and exports the name the app imports', () => {
    const contents = fallbackDataPage(component('Rooms Page'), routes)?.contents ?? '';
    expect(contents).toContain('export function RoomsPage()');
    expect(contents).toContain('{"name":"price","type":"number"}');
    expect(contents).toContain('{"name":"isAvailable","type":"checkbox"}');
    expect(contents).toContain('{"name":"description","type":"text"}');
  });

  it('falls back to the purpose the plan gave the page, preferring the record that links what it names (sapling app, 2026-10-30)', () => {
    const sapling = apiRoutes('backend/src/routes/drive-api.ts', 'drive-api', [
      "router.get('/families', h);",
      "router.post('/families', (req, res) => { const { name, phone } = req.body; });",
      "router.get('/saplings', h);",
      "router.post('/saplings', (req, res) => { const { species, quantity } = req.body; });",
      "router.get('/distributions', h);",
      "router.post('/distributions', (req, res) => { const { familyId, saplingId } = req.body; });",
    ].join('\n'));
    const checkIn = { ...component('Check-In Page'), purpose: 'Verifies family information and records sapling distribution with a log' };
    expect(routeForPage(checkIn, sapling)?.path).toBe('/api/drive-api/distributions');
    const staff = { ...component('Staff Page'), purpose: 'Allows staff to update sapling status' };
    expect(routeForPage(staff, sapling)?.path).toBe('/api/drive-api/saplings');
    expect(fallbackDataPage(checkIn, sapling)?.contents).toContain('{"name":"familyId","type":"number"}');
  });

  it('offers nothing for a page no route is named for', () => {
    expect(fallbackDataPage(component('About Us Page'), routes)).toBeNull();
  });
});
