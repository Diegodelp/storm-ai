# Authoring storm-ai templates

A **template** is a starter project that's pre-configured for storm-ai
so the AI assistant understands the structure from day one. Users run:

```bash
storm new my-app --template <id>
```

…and get a working project with the storm scaffolding already in place,
including a context-compact tree, initial tasks, and (optionally)
project-specific skills and agents.

## Repo layout

A template is a regular GitHub repo with this structure:

```
storm-template-<name>/
├── storm-template.json           # metadata (REQUIRED)
├── template/                     # actual project files (REQUIRED)
│   ├── package.json
│   ├── src/
│   │   └── ...
│   └── ...
└── .storm/                       # storm scaffolding (REQUIRED)
    ├── project.config.json
    ├── CLAUDE.md
    ├── TASKS.md
    ├── .context-compact/
    │   ├── project-map.md
    │   ├── task-state.json
    │   └── <branch>.md ...
    └── .claude/
        ├── commands/
        ├── skills/
        └── agents/
```

When a user creates a project from this template, storm:

1. Clones the repo into a temp directory.
2. Reads `storm-template.json` to know what variables to ask for.
3. Asks the user for the project name and any custom variables.
4. Substitutes `{{VARIABLE}}` placeholders in all text files.
5. Copies `template/*` and `.storm/*` to the user's chosen directory.
6. Runs the `postInstall` commands (e.g., `pnpm install`).
7. Loads `initialTasks` into `task-state.json`.

## storm-template.json

```jsonc
{
  "version": 1,
  "name": "nextjs-saas",
  "label": "Next.js SaaS Starter",
  "description": "Landing + Auth + Dashboard + Stripe + Prisma. Funcional out of the box.",
  "stackId": "nextjs-app",
  "databaseId": "postgres",

  "variables": [
    {
      "key": "STRIPE_PRODUCT",
      "prompt": "¿Qué vendés? (para configurar Stripe)",
      "placeholder": "SaaS de gestión",
      "optional": true
    },
    {
      "key": "PRIMARY_COLOR",
      "prompt": "Color principal (hex)",
      "placeholder": "#7C3AED"
    }
  ],

  "postInstall": [
    "pnpm install",
    "npx prisma generate"
  ],

  "initialTasks": [
    {
      "title": "Personalizar landing page",
      "description": "Cambiar textos, colores y hero section",
      "branches": ["app", "components"]
    },
    {
      "title": "Configurar variables de entorno",
      "description": "Copiar .env.example a .env y completar",
      "branches": ["lib"]
    }
  ]
}
```

### Field reference

- **`name`** (required): slug-friendly, lowercase, hyphens. Used as the
  default project name and for filenames.
- **`label`** (required): human-readable name shown in `storm templates list`.
- **`description`** (required): one-line summary.
- **`stackId`** (required): one of the stack ids storm knows. See
  [`src/core/stacks.js`](../src/core/stacks.js) for the full list.
- **`databaseId`**: optional, similar story.
- **`variables`**: array of values to ask the user for. Each one becomes
  a `{{KEY}}` substitution in every text file under `template/` and `.storm/`.
- **`postInstall`**: shell commands run sequentially in the new project's
  root after copy. Stops at the first failure.
- **`initialTasks`**: pre-loaded into `task-state.json` so the AI has a
  roadmap when the project opens.

## Variable substitution

Storm replaces `{{VARIABLE_NAME}}` in **text files** with the value the
user provides. Binary files (images, fonts) are copied as-is.

Two variables are **always** available, no need to declare them:

- **`{{PROJECT_NAME}}`** — the slug the user typed.
- **`{{PROJECT_NAME_TITLE}}`** — title-cased version (e.g. `my-app` →
  `My App`).

Use them in your `package.json`, `README.md`, page titles, etc.

```json
// template/package.json
{
  "name": "{{PROJECT_NAME}}",
  "description": "Generated from storm-template-nextjs-saas"
}
```

```jsx
// template/app/page.tsx
export const metadata = {
  title: '{{PROJECT_NAME_TITLE}}',
};
```

## Recognized text extensions for substitution

`.js .mjs .cjs .jsx .ts .tsx .json .jsonc .md .mdx .txt .html .css .scss
.sass .svelte .astro .vue .yaml .yml .toml .env .prisma .gitignore`

Files with no extension that are typically text (README, LICENSE,
Dockerfile, Makefile) also get substituted.

If you need substitution in a file with an unrecognized extension, open
an issue and we'll add the extension to the allowlist.

## Best practices

### `.storm/` should be exhaustive

The whole point of a template is that the AI knows the project from day
one. Take time to write good `.context-compact/<branch>.md` files for
every branch. Describe what each module does, what the entry points are,
what conventions to follow.

If `.storm/` is empty or shallow, your template is no better than a
plain `create-next-app` clone.

### `initialTasks` should give the AI a roadmap

Don't include tasks like "implement everything". Break it down:

```json
"initialTasks": [
  { "title": "Personalize the landing copy",  "branches": ["app"] },
  { "title": "Set up the database schema",    "branches": ["prisma"] },
  { "title": "Configure auth providers",      "branches": ["app", "lib"] },
  { "title": "Add custom Stripe products",    "branches": ["app/api"] }
]
```

When the user opens the project, the AI sees these tasks and can pick
one up immediately.

### Test your template

Before publishing, run end-to-end:

```bash
storm new test-from-my-template --template <your-id>
cd test-from-my-template
pnpm dev
```

Make sure:
- It actually builds and runs.
- Variable substitution didn't leave any `{{KEY}}` artifacts.
- `storm task list` shows the initial tasks.
- The CLAUDE.md correctly describes the project.

### Add CI to your template repo

A simple GitHub Action that runs `pnpm install && pnpm build && pnpm test`
on every push catches breakage early.

## Publishing

Once your template repo is ready:

1. Make sure it's **public** on GitHub.
2. Open a PR to `Diegodelp/storm-ai` adding an entry to
   `templates/registry.json`:

   ```json
   {
     "id": "nextjs-saas",
     "label": "Next.js SaaS Starter",
     "description": "Landing + Auth + DB + Stripe.",
     "repo": "your-username/storm-template-nextjs-saas",
     "ref": "main",
     "stackId": "nextjs-app",
     "minStormVersion": "0.3.0"
   }
   ```

3. Once merged, the template appears for all users on their next
   `storm new` or `storm templates list`.

## Versioning your template

If you make a breaking change (rename branches, change variables, etc),
either:

- **Bump the `ref` field** in the registry to a tagged commit
  (e.g., `"ref": "v2"` after creating a `v2` git tag) so old users keep
  getting the old version.
- **Or fork** the template into a new id (`nextjs-saas-v2`) so users can
  choose explicitly.

We don't have automated version negotiation yet — keep changes additive
or use one of the strategies above.
