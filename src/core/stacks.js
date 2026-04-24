/**
 * Stacks and databases catalog.
 *
 * Each stack is a preset that informs:
 *   1. The wizard's stack picker (label + hint).
 *   2. The default branch list created when scaffolding the project.
 *   3. The patterns `storm sync` uses to auto-detect new branches as
 *      the project grows. A pattern is a glob-like string where:
 *        - `*` matches any directory NAME at that level
 *        - segments without `*` must match literally
 *      Examples:
 *        "src/api/*"          → src/api/users, src/api/orders, ...
 *        "app/*"              → app/dashboard, app/settings, ...
 *        "src/components/*"   → src/components/Button, src/components/Card, ...
 *
 *   The `*` always denotes ONE level — we don't expand recursively. A
 *   folder buried deeper than the pattern (e.g. `src/api/users/utils/`)
 *   is NOT treated as a separate branch; it belongs to its parent.
 *
 *   This gives a deterministic, predictable mapping. The user can
 *   always override via project.config.json.
 *
 * Adding a new stack: append to STACKS below. To deprecate one,
 * leave it in place — older project.config.json files reference
 * stack ids by string and we don't want to break read-back.
 */

/**
 * @typedef {Object} StackPreset
 * @property {string} id            Stable identifier (used in project.config.json).
 * @property {string} label         Human-readable name shown in the wizard.
 * @property {string} hint          One-line description for the wizard hint.
 * @property {string[]} branchPatterns   Glob-like patterns for sync.
 * @property {string[]} initialBranches  Branches to scaffold by default
 *                                       (paths the user might want even
 *                                       if folders don't exist yet).
 * @property {{path: string, description: string}[]} branchHints
 *   Pre-baked descriptions for known directory names. When sync auto-
 *   registers a branch matching one of these paths, it uses the hint
 *   instead of leaving the description blank.
 */

/** @type {StackPreset[]} */
export const STACKS = [
  {
    id: 'nextjs-app',
    label: 'Next.js (App Router)',
    hint: 'React framework con app/ y app/api/.',
    branchPatterns: [
      'app/api/*',
      'app/*',
      'components/*',
      'lib/*',
      'hooks/*',
    ],
    initialBranches: [
      'app',
      'app/api',
      'components',
      'lib',
    ],
    branchHints: [
      { path: 'app',         description: 'Páginas y layouts (App Router)' },
      { path: 'app/api',     description: 'Route handlers (server-side)' },
      { path: 'components',  description: 'Componentes UI compartidos' },
      { path: 'lib',         description: 'Helpers y utilidades' },
      { path: 'hooks',       description: 'React hooks reutilizables' },
    ],
  },
  {
    id: 'nextjs-pages',
    label: 'Next.js (Pages Router)',
    hint: 'Variante clásica con pages/ y pages/api/.',
    branchPatterns: [
      'pages/api/*',
      'pages/*',
      'components/*',
      'lib/*',
      'hooks/*',
    ],
    initialBranches: [
      'pages',
      'pages/api',
      'components',
      'lib',
    ],
    branchHints: [
      { path: 'pages',       description: 'Páginas (Pages Router)' },
      { path: 'pages/api',   description: 'API routes' },
      { path: 'components',  description: 'Componentes UI compartidos' },
      { path: 'lib',         description: 'Helpers y utilidades' },
    ],
  },
  {
    id: 'react-vite',
    label: 'React + Vite SPA',
    hint: 'Single-page app con Vite.',
    branchPatterns: [
      'src/components/*',
      'src/pages/*',
      'src/hooks/*',
      'src/services/*',
      'src/store/*',
    ],
    initialBranches: [
      'src/components',
      'src/pages',
      'src/services',
    ],
    branchHints: [
      { path: 'src/components', description: 'Componentes React' },
      { path: 'src/pages',      description: 'Vistas / rutas' },
      { path: 'src/hooks',      description: 'Hooks reutilizables' },
      { path: 'src/services',   description: 'Clientes HTTP / lógica de negocio' },
      { path: 'src/store',      description: 'Estado global' },
    ],
  },
  {
    id: 'astro',
    label: 'Astro',
    hint: 'Sitios estáticos con islas interactivas.',
    branchPatterns: [
      'src/pages/*',
      'src/components/*',
      'src/layouts/*',
      'src/content/*',
    ],
    initialBranches: [
      'src/pages',
      'src/components',
      'src/layouts',
    ],
    branchHints: [
      { path: 'src/pages',      description: 'Páginas Astro' },
      { path: 'src/components', description: 'Componentes (Astro/JSX/Svelte)' },
      { path: 'src/layouts',    description: 'Layouts de página' },
      { path: 'src/content',    description: 'Content collections' },
    ],
  },
  {
    id: 'sveltekit',
    label: 'SvelteKit',
    hint: 'Framework Svelte full-stack.',
    branchPatterns: [
      'src/routes/*',
      'src/lib/components/*',
      'src/lib/*',
    ],
    initialBranches: [
      'src/routes',
      'src/lib',
      'src/lib/components',
    ],
    branchHints: [
      { path: 'src/routes',          description: 'Rutas y endpoints' },
      { path: 'src/lib',             description: 'Helpers y módulos compartidos' },
      { path: 'src/lib/components',  description: 'Componentes Svelte' },
    ],
  },
  {
    id: 'express-prisma',
    label: 'Express + Prisma',
    hint: 'API REST en Node con Prisma ORM.',
    branchPatterns: [
      'src/routes/*',
      'src/controllers/*',
      'src/services/*',
      'src/middleware/*',
      'prisma/*',
    ],
    initialBranches: [
      'src/routes',
      'src/controllers',
      'src/services',
      'src/middleware',
      'prisma',
    ],
    branchHints: [
      { path: 'src/routes',      description: 'Definiciones de endpoints' },
      { path: 'src/controllers', description: 'Handlers de cada endpoint' },
      { path: 'src/services',    description: 'Lógica de negocio' },
      { path: 'src/middleware',  description: 'Middlewares Express' },
      { path: 'prisma',          description: 'Schema y migraciones' },
    ],
  },
  {
    id: 'nestjs',
    label: 'NestJS',
    hint: 'Framework Node estructurado por módulos.',
    branchPatterns: [
      'src/modules/*',
      'src/common/*',
      'src/config/*',
    ],
    initialBranches: [
      'src/modules',
      'src/common',
      'src/config',
    ],
    branchHints: [
      { path: 'src/modules', description: 'Módulos de negocio' },
      { path: 'src/common',  description: 'Utilidades, pipes, filters' },
      { path: 'src/config',  description: 'Configuración runtime' },
    ],
  },
  {
    id: 'fastify',
    label: 'Fastify',
    hint: 'API HTTP minimalista y rápida.',
    branchPatterns: [
      'src/routes/*',
      'src/plugins/*',
      'src/services/*',
    ],
    initialBranches: [
      'src/routes',
      'src/plugins',
      'src/services',
    ],
    branchHints: [
      { path: 'src/routes',   description: 'Endpoints' },
      { path: 'src/plugins',  description: 'Plugins Fastify' },
      { path: 'src/services', description: 'Lógica de negocio' },
    ],
  },
  {
    id: 'monorepo-turbo',
    label: 'Monorepo (Turborepo)',
    hint: 'apps/ + packages/ con Turborepo.',
    branchPatterns: [
      'apps/*',
      'packages/*',
    ],
    initialBranches: [
      'apps',
      'packages',
    ],
    branchHints: [
      { path: 'apps',     description: 'Aplicaciones del workspace' },
      { path: 'packages', description: 'Librerías compartidas' },
    ],
  },
  {
    id: 'cli-node',
    label: 'CLI (Node)',
    hint: 'Herramienta de línea de comandos en Node.',
    branchPatterns: [
      'src/commands/*',
      'src/core/*',
      'src/ui/*',
    ],
    initialBranches: [
      'src/commands',
      'src/core',
      'src/ui',
    ],
    branchHints: [
      { path: 'src/commands', description: 'Subcomandos del CLI' },
      { path: 'src/core',     description: 'Lógica central, IO' },
      { path: 'src/ui',       description: 'Renderizado del terminal' },
    ],
  },
  {
    id: 'other',
    label: 'Otro... (texto libre)',
    hint: 'Stack no listado — describilo a mano.',
    branchPatterns: [],
    initialBranches: [],
    branchHints: [],
  },
];

/**
 * @typedef {Object} DatabasePreset
 * @property {string} id
 * @property {string} label
 * @property {string} hint
 */

/** @type {DatabasePreset[]} */
export const DATABASES = [
  { id: 'postgres',  label: 'PostgreSQL', hint: 'Relacional, transaccional.' },
  { id: 'mysql',     label: 'MySQL',      hint: 'Relacional, ampliamente soportado.' },
  { id: 'sqlite',    label: 'SQLite',     hint: 'Embebido, archivo local.' },
  { id: 'mongodb',   label: 'MongoDB',    hint: 'Documental, flexible.' },
  { id: 'supabase',  label: 'Supabase',   hint: 'Postgres + Auth + Realtime gestionado.' },
  { id: 'firebase',  label: 'Firebase',   hint: 'Firestore + Auth de Google.' },
  { id: 'planetscale', label: 'PlanetScale', hint: 'MySQL serverless con branching.' },
  { id: 'neon',      label: 'Neon',       hint: 'Postgres serverless.' },
  { id: 'redis',     label: 'Redis',      hint: 'Cache / clave-valor / colas.' },
  { id: 'none',      label: 'Ninguna',    hint: 'No usa base de datos.' },
  { id: 'other',     label: 'Otra... (texto libre)', hint: 'Describila a mano.' },
];

/**
 * Look up a stack by id. Returns null if unknown.
 * @param {string} id
 * @returns {StackPreset|null}
 */
export function getStack(id) {
  return STACKS.find((s) => s.id === id) ?? null;
}

/**
 * Look up a database by id. Returns null if unknown.
 * @param {string} id
 * @returns {DatabasePreset|null}
 */
export function getDatabase(id) {
  return DATABASES.find((d) => d.id === id) ?? null;
}

/**
 * Test whether a relative path matches any of the stack's branch patterns.
 * Pattern syntax (single `*` per segment, no `**`):
 *   "src/api/*"  matches "src/api/users"  but NOT "src/api/users/v1"
 *
 * @param {string} relPath           Relative path with forward slashes.
 * @param {string[]} branchPatterns  Patterns from the stack preset.
 * @returns {boolean}
 */
export function matchesAnyPattern(relPath, branchPatterns) {
  const pathParts = relPath.split('/').filter(Boolean);
  for (const pattern of branchPatterns) {
    const patParts = pattern.split('/').filter(Boolean);
    if (patParts.length !== pathParts.length) continue;
    let ok = true;
    for (let i = 0; i < patParts.length; i++) {
      if (patParts[i] === '*') continue;
      if (patParts[i] !== pathParts[i]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

/**
 * Suggest a description for a freshly auto-detected branch by matching
 * its path against the stack's branchHints. Falls back to a generic hint.
 *
 * @param {string} relPath
 * @param {StackPreset} stack
 * @returns {string}
 */
export function suggestBranchDescription(relPath, stack) {
  // Prefer exact matches first (e.g. "src/api" → "API endpoints").
  const exact = stack.branchHints.find((h) => h.path === relPath);
  if (exact) return exact.description;

  // Then try parent matches (e.g. "src/api/payments" inherits hint of
  // "src/api" with a suffix).
  const sortedHints = [...stack.branchHints].sort(
    (a, b) => b.path.length - a.path.length,
  );
  for (const hint of sortedHints) {
    if (relPath.startsWith(hint.path + '/')) {
      const sub = relPath.slice(hint.path.length + 1);
      return `${hint.description} — ${sub}`;
    }
  }
  return '';
}
