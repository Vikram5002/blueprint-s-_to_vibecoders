import { describe, expect, it } from 'vitest';
import {
  backendEntryPointFile,
  componentSlug,
  componentTargetPath,
  frontendEntryPointFile,
  packageJsonFile,
  pascalIdentifier,
  tsconfigFile,
} from './assemble.js';
import type { Component } from '../types/project-schema.js';

const USER_ROUTER: Component = { id: '1', name: 'UserRouter', purpose: 'x' };
const AUTH_MIDDLEWARE: Component = { id: '2', name: 'AuthMiddleware', purpose: 'y' };
const RECIPE_STORE: Component = { id: '3', name: 'RecipeStore', purpose: 'z' };
const RECIPE_LIST_PAGE: Component = { id: '4', name: 'RecipeListPage', purpose: 'w' };

describe('componentSlug', () => {
  it('converts PascalCase to kebab-case', () => {
    expect(componentSlug('UserRouter')).toBe('user-router');
    expect(componentSlug('AuthMiddleware')).toBe('auth-middleware');
  });

  it('strips characters that are not alphanumeric or hyphen', () => {
    expect(componentSlug('User Router!!')).toBe('user-router');
  });

  it('folds accented letters to their base letter instead of dropping them', () => {
    expect(componentSlug('Café Menu')).toBe('cafe-menu');
    expect(componentSlug('CrèmeBrûléeRouter')).toBe('creme-brulee-router');
    expect(componentSlug('Ñandú')).toBe('nandu');
  });
});

describe('componentTargetPath', () => {
  it('places backend components under backend/src/routes', () => {
    expect(componentTargetPath('backend', USER_ROUTER)).toBe('backend/src/routes/user-router.ts');
  });

  it('folds security components into backend/src/middleware', () => {
    expect(componentTargetPath('security', AUTH_MIDDLEWARE)).toBe('backend/src/middleware/auth-middleware.ts');
  });

  it('folds database components into backend/src/db', () => {
    expect(componentTargetPath('database', RECIPE_STORE)).toBe('backend/src/db/recipe-store.ts');
  });

  it('gives frontend components their own top-level folder, not folded into backend', () => {
    expect(componentTargetPath('frontend', RECIPE_LIST_PAGE)).toBe('frontend/src/pages/recipe-list-page.tsx');
  });
});

describe('packageJsonFile / tsconfigFile', () => {
  it('produce a backend-only manifest by default, unchanged from Milestone 1', () => {
    const pkg = JSON.parse(packageJsonFile().contents);
    expect(pkg.dependencies.express).toBeDefined();
    expect(pkg.dependencies.react).toBeUndefined();
    expect(pkg.devDependencies.typescript).toBeDefined();
    expect(pkg.devDependencies['@types/node']).toBe('^20.14.0');
    expect(pkg.engines).toBeUndefined();

    const tsconfig = JSON.parse(tsconfigFile().contents);
    expect(tsconfig.compilerOptions.module).toBe('commonjs');
    expect(tsconfig.compilerOptions.jsx).toBeUndefined();
    expect(tsconfig.include).toEqual(['backend/**/*.ts']);
  });

  it('adds no extra npm dependency for the database domain - node:sqlite is built in', () => {
    const pkg = JSON.parse(packageJsonFile({ database: true }).contents);
    expect(pkg.dependencies['better-sqlite3']).toBeUndefined();
    expect(pkg.devDependencies['@types/better-sqlite3']).toBeUndefined();
    // node:sqlite's type declarations need a recent @types/node.
    expect(pkg.devDependencies['@types/node']).toBe('^22.10.0');
    expect(pkg.engines).toEqual({ node: '>=22.5.0' });
  });

  it('adds react + jsx support when the frontend domain is present', () => {
    const pkg = JSON.parse(packageJsonFile({ frontend: true }).contents);
    expect(pkg.dependencies.react).toBeDefined();
    expect(pkg.dependencies['react-dom']).toBeDefined();

    const tsconfig = JSON.parse(tsconfigFile({ frontend: true }).contents);
    expect(tsconfig.compilerOptions.jsx).toBe('react-jsx');
    expect(tsconfig.include).toEqual(['backend/**/*.ts', 'frontend/**/*.tsx']);
  });
});

describe('frontendEntryPointFile', () => {
  it('imports and mounts every frontend component into #root', () => {
    const file = frontendEntryPointFile([RECIPE_LIST_PAGE]);

    expect(file.path).toBe('frontend/src/main.tsx');
    expect(file.contents).toContain("import { RecipeListPage } from './pages/recipe-list-page';");
    expect(file.contents).toContain('createRoot(container).render(');
    expect(file.contents).toContain('Page: RecipeListPage }');
  });

  it('builds a real site: a home page with a card per page, a navigation bar, one page at a time', () => {
    const second: Component = { id: '9', name: 'Add Recipe', purpose: 'A form to add a recipe with its title and steps.' };
    const file = frontendEntryPointFile([RECIPE_LIST_PAGE, second], 'Recipe Box');

    expect(file.contents).toContain('const SITE_TITLE = "Recipe Box";');
    expect(file.contents).toContain('{ path: "add-recipe", title: "Add Recipe", purpose: "A form to add a recipe with its title and steps.", Page: AddRecipe },');
    expect(file.contents).toContain('function Home(): JSX.Element {');
    expect(file.contents).toContain("<nav style={{ display: 'flex', flexWrap: 'wrap'");
    expect(file.contents).toContain('{current === undefined ? <Home /> : <current.Page />}');
    expect(file.contents).toContain("window.addEventListener('hashchange', onChange);");
  });

  it('writes the title and purposes as string literals, so quotes in them cannot break the file', () => {
    const quoted: Component = { id: '8', name: 'Orders', purpose: `Shows "today's" orders` };
    const file = frontendEntryPointFile([quoted], `Joe's "Diner"`);

    expect(file.contents).toContain(`const SITE_TITLE = "Joe's \\"Diner\\"";`);
    expect(file.contents).toContain(`purpose: "Shows \\"today's\\" orders"`);
  });

  // Regression: a live run of the real Layer 2 schema generator produced a
  // component named "Recipe Dashboard" (a space, not PascalCase) - naively
  // importing `{ ${component.name} }` produced `import { Recipe Dashboard
  // ... }`, invalid JS syntax that failed npm run build with TS1005 (",'
  // expected"). The import binding must always be the sanitized
  // pascalIdentifier(componentSlug(...)) derivation, never the raw name.
  it('sanitizes a component name containing spaces into a valid import identifier', () => {
    const RECIPE_DASHBOARD: Component = { id: '5', name: 'Recipe Dashboard', purpose: 'v' };
    const file = frontendEntryPointFile([RECIPE_DASHBOARD]);

    expect(file.contents).toContain("import { RecipeDashboard } from './pages/recipe-dashboard';");
    expect(file.contents).not.toContain('import { Recipe Dashboard');
    // The display title keeps the planned name; only the identifier is sanitized.
    expect(file.contents).toContain('title: "Recipe Dashboard", purpose: "v", Page: RecipeDashboard }');
  });
});

describe('backendEntryPointFile', () => {
  it('answers a database refusal (missing linked record) with 400, after every router - the hotel app crash of 2026-10-28', () => {
    const file = backendEntryPointFile([USER_ROUTER], [AUTH_MIDDLEWARE]);
    expect(file.contents).toContain("if (message.includes('FOREIGN KEY constraint failed')) return res.status(400)");
    expect(file.contents.indexOf('FOREIGN KEY')).toBeGreaterThan(file.contents.indexOf("app.use('/api/user-router'"));
  });

  it('mounts security middleware globally before backend routers, each at /api/<slug>', () => {
    const file = backendEntryPointFile([USER_ROUTER], [AUTH_MIDDLEWARE]);

    expect(file.path).toBe('backend/src/index.ts');
    expect(file.contents).toContain("import { middleware as authMiddleware } from './middleware/auth-middleware';");
    expect(file.contents).toContain("import { router as userRouter } from './routes/user-router';");
    expect(file.contents).toContain('app.use(authMiddleware);');
    expect(file.contents).toContain("app.use('/api/user-router', userRouter);");

    const middlewareIndex = file.contents.indexOf('app.use(authMiddleware);');
    const routerIndex = file.contents.indexOf("app.use('/api/user-router'");
    expect(middlewareIndex).toBeGreaterThan(-1);
    expect(routerIndex).toBeGreaterThan(middlewareIndex);
  });

  it('produces no middleware wiring when there are no security components', () => {
    const file = backendEntryPointFile([USER_ROUTER], []);
    expect(file.contents).not.toContain('middleware');
  });
});

describe('backendEntryPointFile - public routes', () => {
  const RATE_LIMITER: Component = { id: '5', name: 'Rate Limiter', purpose: 'Limits requests per IP.' };
  const publicRoute = [{ method: 'POST', path: '/api/sign-up-api' }];

  it('lets a public route past the authentication middleware only', () => {
    const { contents } = backendEntryPointFile([USER_ROUTER], [RATE_LIMITER, AUTH_MIDDLEWARE], publicRoute);
    expect(contents).toContain('const PUBLIC_ROUTES');
    expect(contents).toContain('"method":"POST","path":"/api/sign-up-api"');
    expect(contents).toContain('app.use(unlessPublic(authMiddleware));');
    expect(contents).toContain('app.use(rateLimiter);');
  });

  it('is unchanged when there are no public routes', () => {
    const { contents } = backendEntryPointFile([USER_ROUTER], [AUTH_MIDDLEWARE]);
    expect(contents).not.toContain('PUBLIC_ROUTES');
    expect(contents).toContain('app.use(authMiddleware);');
  });

  it('adds nothing when no security component authenticates', () => {
    const { contents } = backendEntryPointFile([USER_ROUTER], [RATE_LIMITER], publicRoute);
    expect(contents).not.toContain('unlessPublic');
  });
});

describe('identifiers for names that start with a digit', () => {
  it('imports a backend component named "2FA Router" under a valid identifier', () => {
    const file = backendEntryPointFile([{ id: 'x', name: '2FA Router', purpose: 'p' }], []);
    expect(file.contents).toContain("import { router as _2FaRouter } from './routes/2-fa-router';");
    expect(file.contents).toContain("app.use('/api/2-fa-router', _2FaRouter);");
  });

  it('leaves names that already worked unchanged', () => {
    expect(pascalIdentifier('recipe-dashboard')).toBe('RecipeDashboard');
  });
});
