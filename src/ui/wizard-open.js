/**
 * Selector interactivo de proyectos.
 *
 * Escanea las carpetas por defecto, deja al usuario elegir, muestra con
 * qué agent/provider/modelo se va a abrir y permite abrirlo o cambiar
 * esa configuración (que es del proyecto, no global).
 */

import * as clack from '@clack/prompts';

import { discover } from '../commands/open.js';
import { launchForProject } from '../commands/launch.js';
import { getProjectSettings } from '../commands/project.js';
import { agentLabel } from '../core/agents.js';
import { runProjectSettingsWizard, describeProjectSettings } from './wizard-project.js';
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

  while (true) {
    let settings;
    try {
      settings = await getProjectSettings(picked.root);
    } catch (err) {
      clack.log.error(`No pude leer project.config.json: ${err.message}`);
      return;
    }
    clack.note(
      `${ansi.bold(picked.name)}\n${ansi.dim(picked.root)}\n\n${describeProjectSettings(settings)}`,
      'Seleccionado',
    );

    const action = await clack.select({
      message: '¿Qué hacemos?',
      options: [
        { value: 'open', label: `Abrir con ${agentLabel(settings.agent)}` },
        { value: 'settings', label: 'Cambiar agent / provider / modelo de este proyecto' },
        { value: 'back', label: '← Volver' },
      ],
    });
    if (clack.isCancel(action) || action === 'back') return;

    if (action === 'settings') {
      await runProjectSettingsWizard({ projectRoot: picked.root });
      continue;
    }

    clack.log.info(`Abriendo ${agentLabel(settings.agent)}...`);
    try {
      await launchForProject({ projectRoot: picked.root });
      return;
    } catch (err) {
      clack.log.error(`No pude abrir: ${err.message}`);
      // Loop back so the user can fix the settings right here.
    }
  }
}
