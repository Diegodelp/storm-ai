/**
 * Selector interactivo de proyectos + auto-launch.
 *
 * Escanea las carpetas por defecto, deja al usuario elegir, y abre
 * Claude Code con el provider/modelo del proyecto.
 */

import * as clack from '@clack/prompts';

import { discover } from '../commands/open.js';
import { launchForProject } from '../commands/launch.js';
import * as ansi from './ansi.js';

export async function runOpenWizard() {
  clack.intro(ansi.bold('Seleccionar proyecto'));
  clack.log.info(ansi.dim('Tip: presioná Esc en cualquier momento para volver al menú.'));

  const spinner = clack.spinner();
  spinner.start('Buscando proyectos storm');
  const found = await discover({});
  spinner.stop(`Encontrados: ${found.length}`);

  if (found.length === 0) {
    clack.log.warn(
      'No se encontraron proyectos en las carpetas habituales (Desktop, Documents, Projects, code, dev).',
    );
    clack.log.info('Creá uno con "Crear proyecto" o corré: storm new <nombre>');
    return;
  }

  const choice = await clack.select({
    message: 'Elegí un proyecto',
    options: found.map((p) => ({
      value: p.root,
      label: p.name,
      hint: p.root,
    })),
  });
  if (clack.isCancel(choice)) {
    clack.cancel('Cancelado.');
    return;
  }

  const picked = found.find((p) => p.root === choice);
  clack.note(
    `${ansi.bold(picked.name)}\n${ansi.dim(picked.root)}\n\nAbriendo Claude Code...`,
    'Seleccionado',
  );

  try {
    await launchForProject({ projectRoot: picked.root });
  } catch (err) {
    clack.log.error(
      `No pude abrir: ${err.message}\n` +
        `Abrilo a mano:\n  cd "${picked.root}"\n  claude`,
    );
  }
}
