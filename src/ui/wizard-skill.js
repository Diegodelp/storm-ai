/**
 * Interactive wizard for `storm skill add` (no args).
 *
 * Asks for name, optional description, and optional branches the
 * skill should preload. Then writes .claude/skills/<slug>.md and
 * updates project.config.json.
 */

import * as clack from '@clack/prompts';
import path from 'node:path';

import { addSkill } from '../commands/skill.js';
import { readConfig } from '../core/config.js';
import { requireProjectRoot } from '../core/paths.js';
import * as ansi from './ansi.js';

export async function runSkillAddWizard({ cwd }) {
  let projectRoot;
  try {
    projectRoot = await requireProjectRoot(cwd);
  } catch (err) {
    clack.log.error(err.message ?? String(err));
    return;
  }

  clack.intro(ansi.bold('Nueva skill'));
  clack.log.info(ansi.dim('Tip: presioná Esc en cualquier momento para volver al menú.'));

  const name = await clack.text({
    message: 'Nombre de la skill',
    placeholder: 'auth-flow-reviewer',
    validate: (v) => (v?.trim() ? undefined : 'El nombre es obligatorio'),
  });
  if (clack.isCancel(name)) return cancel();

  const description = await clack.text({
    message: 'Descripción de una línea (opcional)',
    placeholder: 'Revisa el flujo de autenticación antes de cada PR',
  });
  if (clack.isCancel(description)) return cancel();

  // Branch picker: read available branches from config so the user
  // doesn't have to remember names.
  let branchOptions = [];
  try {
    const config = await readConfig(projectRoot);
    branchOptions = (config.compact_context?.branches ?? [])
      .filter((b) => !b.stale)
      .map((b) => ({ value: b.path, label: b.path }));
  } catch {
    // proyecto sin config válido: seguimos sin selección
  }

  let branches = [];
  if (branchOptions.length > 0) {
    const picked = await clack.multiselect({
      message: 'Branches relacionadas (opcional, espacio para marcar)',
      options: branchOptions,
      required: false,
    });
    if (clack.isCancel(picked)) return cancel();
    branches = picked ?? [];
  }

  const spinner = clack.spinner();
  spinner.start('Creando skill');
  let result;
  try {
    result = await addSkill({
      cwd,
      projectRoot,
      name,
      description: description || '',
      branches,
    });
    spinner.stop(result.created ? 'Skill creada' : 'Skill ya existía');
  } catch (err) {
    spinner.stop(ansi.red('Falló'));
    clack.log.error(err.message ?? String(err));
    return;
  }

  clack.note(
    `Slug: ${ansi.cyan(result.slug)}\n` +
      `Archivo: ${ansi.dim(path.relative(projectRoot, result.file))}\n\n` +
      'Editalo para completar los pasos y el output esperado.',
    'Lista',
  );
}

function cancel() {
  clack.cancel('Cancelado.');
}
