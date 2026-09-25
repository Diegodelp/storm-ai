/**
 * Wizard interactivo para `storm project`: cambiar cómo se lanza UN
 * proyecto (agent, provider, modelo, comando custom).
 *
 * Esto edita <proyecto>/project.config.json. La config global
 * (`storm config`) solo define los defaults para proyectos nuevos.
 */

import * as clack from '@clack/prompts';

import { getProjectSettings, updateProjectSettings, validateProjectSettings } from '../commands/project.js';
import { agentLabel } from '../core/agents.js';
import { providerNeedsModel } from '../core/providers.js';
import { pickLaunchSettings, pickModel, providerLabel } from './pick-launch.js';
import * as ansi from './ansi.js';

/**
 * Texto de una línea por setting, para notes de clack.
 * @param {import('../commands/project.js').ProjectLaunchSettings} s
 */
export function describeProjectSettings(s) {
  const lines = [
    `Agent:     ${ansi.cyan(agentLabel(s.agent))}`,
    `Provider:  ${ansi.cyan(providerLabel(s.provider))}${s.model ? ` (${s.model})` : ''}`,
  ];
  if (s.launchCommand) lines.push(`Comando:   ${ansi.cyan(s.launchCommand)}`);
  const problem = validateProjectSettings(s);
  if (problem) lines.push('', ansi.yellow(`⚠ ${problem}`));
  return lines.join('\n');
}

/**
 * @param {{projectRoot: string}} input
 * @returns {Promise<boolean>}  true si se guardó algún cambio.
 */
export async function runProjectSettingsWizard({ projectRoot }) {
  let changed = false;
  while (true) {
    const s = await getProjectSettings(projectRoot);
    clack.note(describeProjectSettings(s), 'Configuración del proyecto');

    const options = [
      { value: 'all', label: 'Cambiar agent, provider y modelo' },
    ];
    if (providerNeedsModel(s.provider)) {
      options.push({ value: 'model', label: 'Cambiar solo el modelo' });
    }
    options.push(
      { value: 'cmd', label: s.launchCommand ? 'Editar/quitar comando custom' : 'Definir comando custom' },
      { value: 'back', label: '← Volver' },
    );

    const action = await clack.select({ message: '¿Qué querés cambiar?', options });
    if (clack.isCancel(action) || action === 'back') return changed;

    /** @type {Partial<import('../commands/project.js').ProjectLaunchSettings>|null} */
    let patch = null;
    if (action === 'all') {
      const picked = await pickLaunchSettings(s);
      if (!picked) continue;
      patch = {
        agent: picked.agent,
        provider: picked.model.provider,
        model: picked.model.name,
        // Known agents use their template; a custom agent brings its own command.
        launchCommand: picked.launchCommand,
      };
    } else if (action === 'model') {
      const m = await pickModel(s.provider, { initialValue: s.model });
      if (!m) continue;
      patch = { model: m.name };
    } else if (action === 'cmd') {
      const cmd = await clack.text({
        message: `Comando (usá ${ansi.cyan('{{model}}')} para el modelo). Vacío = usar el template del agent`,
        placeholder: 'aider --model {{model}}',
        initialValue: s.launchCommand ?? '',
      });
      if (clack.isCancel(cmd)) continue;
      patch = { launchCommand: cmd?.trim() || null };
    }

    try {
      const r = await updateProjectSettings(projectRoot, patch);
      changed = true;
      clack.log.success('Guardado en project.config.json.');
      for (const n of r.notes) clack.log.info(n);
      if (r.scaffold?.createdFiles.length) {
        clack.log.info(`Archivos de ${agentLabel(r.after.agent)} creados: ${r.scaffold.createdFiles.join(', ')}`);
      }
      if (r.scaffold?.skippedFiles.length) {
        clack.log.info(ansi.dim(`Ya existían (no se tocaron): ${r.scaffold.skippedFiles.join(', ')}`));
      }
    } catch (err) {
      clack.log.error(err.message ?? String(err));
    }
  }
}
