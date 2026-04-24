/**
 * `storm skill` — manage per-project skills.
 *
 * Skills live in `.claude/skills/<slug>.md` (Claude Code reads this
 * folder automatically). They are also tracked in project.config.json
 * so storm can list them and so the CLAUDE.md preamble can mention them.
 *
 * Built-in skills (compact-route, refresh-compact, plan-systematic) are
 * inserted at scaffold time and have `builtin: true`. They live in the
 * same folder but their content is curated by storm — we don't add or
 * remove them from here.
 *
 * Subcommands:
 *   storm skill list                 → table of skills (builtin + custom)
 *   storm skill add <name>           → create .claude/skills/<slug>.md
 *   storm skill remove <name>        → delete the file + config entry
 *
 * The interactive variants (no <name> arg) are wired in src/ui/wizard-skill.js.
 */

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { readConfig, writeConfig } from '../core/config.js';
import { safeName } from '../core/paths.js';

const SKILLS_DIR = '.claude/skills';

/**
 * @typedef {Object} SkillInput
 * @property {string} name              Display name (free text).
 * @property {string} [description]     One-line summary.
 * @property {string[]} [branches]      Branch paths this skill targets.
 * @property {string} [body]            Full markdown body. Auto-generated
 *                                      from a template if omitted.
 */

/**
 * Add a skill. Idempotent on the slug — if a skill with the same slug
 * exists, returns it without overwriting.
 *
 * @param {{cwd: string, projectRoot: string} & SkillInput} input
 * @returns {Promise<{slug: string, file: string, created: boolean}>}
 */
export async function addSkill(input) {
  if (!input.name?.trim()) {
    throw new Error('El nombre de la skill es obligatorio.');
  }

  const slug = safeName(input.name).toLowerCase();
  const config = await readConfig(input.projectRoot);

  const existing = config.skills.find((s) => s.name === slug);
  const file = path.join(input.projectRoot, SKILLS_DIR, `${slug}.md`);

  // Idempotent: if both file and config entry exist, return without modifying.
  if (existing) {
    let fileExists = true;
    try {
      await readFile(file);
    } catch {
      fileExists = false;
    }
    if (fileExists) {
      return { slug, file, created: false };
    }
  }

  // Materialize the file.
  await mkdir(path.dirname(file), { recursive: true });
  const body = input.body ?? renderSkillTemplate({
    name: input.name,
    slug,
    description: input.description ?? '',
    branches: input.branches ?? [],
  });
  await writeFile(file, body, 'utf8');

  // Update config.
  if (!existing) {
    config.skills.push({
      name: slug,
      builtin: false,
      description: input.description ?? '',
    });
    await writeConfig(input.projectRoot, config);
  }

  return { slug, file, created: true };
}

/**
 * List all skills (built-in and custom). Reads the config — does not
 * touch the filesystem.
 *
 * @param {{projectRoot: string}} input
 * @returns {Promise<{name: string, builtin: boolean, description: string, file: string|null}[]>}
 */
export async function listSkills(input) {
  const config = await readConfig(input.projectRoot);
  return config.skills.map((s) => ({
    name: s.name,
    builtin: !!s.builtin,
    description: s.description ?? '',
    file: path.join(input.projectRoot, SKILLS_DIR, `${s.name}.md`),
  }));
}

/**
 * Remove a custom skill. Built-in skills are protected.
 *
 * @param {{projectRoot: string, name: string}} input
 * @returns {Promise<{removed: boolean, reason?: string}>}
 */
export async function removeSkill(input) {
  const slug = safeName(input.name).toLowerCase();
  const config = await readConfig(input.projectRoot);

  const idx = config.skills.findIndex((s) => s.name === slug);
  if (idx === -1) {
    return { removed: false, reason: `No existe la skill "${slug}".` };
  }
  if (config.skills[idx].builtin) {
    return {
      removed: false,
      reason: `"${slug}" es built-in y no se puede borrar desde el CLI.`,
    };
  }

  // Remove file (best-effort).
  const file = path.join(input.projectRoot, SKILLS_DIR, `${slug}.md`);
  try {
    await rm(file, { force: true });
  } catch {
    // file may not exist — keep going.
  }

  config.skills.splice(idx, 1);
  await writeConfig(input.projectRoot, config);
  return { removed: true };
}

// ---------------------------------------------------------------------------
// Template
// ---------------------------------------------------------------------------

/**
 * Default body for a freshly-added skill. The user (or the AI) is
 * expected to expand it.
 */
function renderSkillTemplate({ name, slug, description, branches }) {
  const branchesBlock = branches.length
    ? branches.map((b) => `- \`${b}\``).join('\n')
    : '_(ninguna)_';

  return `# ${name}

**Slug:** \`${slug}\`
**Tipo:** custom (creada por el usuario)

## Descripción

${description || '_Describí brevemente qué hace esta skill y cuándo usarla._'}

## Cuándo invocarla

<!-- Bajo qué condiciones la IA debería activar esta skill.
     Ejemplo: "Cuando se modifica un archivo bajo src/api/, antes de hacer commit." -->

## Contexto a cargar

Branches relevantes:
${branchesBlock}

## Pasos

<!-- Lista numerada de pasos que la skill debe seguir. -->

1. _(paso 1)_
2. _(paso 2)_
3. _(paso 3)_

## Output esperado

<!-- Qué produce esta skill: un PR, un reporte, código, una nota? -->
`;
}
