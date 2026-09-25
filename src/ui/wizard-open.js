/**
 * Selector interactivo de proyectos + auto-launch.
 *
 * Escanea las carpetas por defecto, deja al usuario elegir, y abre
 * el CLI configurado con el provider/modelo del proyecto.
 */

import * as clack from '@clack/prompts';

import { discover } from '../commands/open.js';
import { launchForProject } from '../commands/launch.js';
import { readConfig } from '../core/config.js';
import { getAgent } from '../core/agents.js';
import * as ansi from './ansi.js';

export async function runOpenWizard(_input = {}, {
  discoverProjects = discover,
  launchProject = launchForProject,
  loadConfig = readConfig,
  ui = clack,
} = {}) {
  ui.intro(ansi.bold('Seleccionar proyecto'));
  ui.log.info(ansi.dim('Tip: presioná Esc en cualquier momento para volver al menú.'));

  const spinner = ui.spinner();
  spinner.start('Buscando proyectos storm');
  let found;
  try {
    found = await discoverProjects({});
  } catch (err) {
    spinner.stop('Falló la búsqueda de proyectos');
    throw err;
  }
  spinner.stop(`Encontrados: ${found.length}`);

  if (found.length === 0) {
    ui.log.warn(
      'No se encontraron proyectos en las carpetas habituales (Desktop, Documents, Projects, code, dev).',
    );
    ui.log.info('Creá uno con "Crear proyecto" o corré: storm new <nombre>');
    return 'empty';
  }

  const choice = await ui.select({
    message: 'Elegí un proyecto',
    options: found.map((p) => ({
      value: p.root,
      label: p.name,
      hint: p.root,
    })),
  });
  if (ui.isCancel(choice)) {
    ui.cancel('Cancelado.');
    return 'cancelled';
  }

  const picked = found.find((p) => p.root === choice);
  if (!picked) throw new Error('No se encontró el proyecto seleccionado. Volvé a buscarlo.');

  try {
    const config = await loadConfig(picked.root);
    const agent = getAgent(config.agent)?.label ?? config.agent;
    const launcher = config.launch?.customCommand ? 'comando personalizado' : agent;
    ui.note(
      `${ansi.bold(picked.name)}\n${ansi.dim(picked.root)}\n` +
        `CLI: ${launcher}\nProvider: ${config.model.provider}\n` +
        `Modelo: ${config.model.name ?? 'automático'}\n\nAbriendo ${launcher}...`,
      'Seleccionado',
    );
    await launchProject({ projectRoot: picked.root });
    ui.log.info(`${launcher} finalizó. Proyecto: ${picked.name}.`);
    return 'done';
  } catch (err) {
    throw new Error(
      `No pude abrir el proyecto "${picked.name}".\n` +
        `${err?.message ?? String(err)}\n\n` +
        `Para reintentar:\n  cd "${picked.root}"\n  storm launch`,
      { cause: err },
    );
  }
}
