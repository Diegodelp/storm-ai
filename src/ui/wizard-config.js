/**
 * Wizard interactivo para `storm config`.
 *
 * Muestra el estado actual de la configuración global y permite
 * editar cada campo. La configuración vive en ~/.storm-ai/config.json.
 *
 * Son DEFAULTS: se usan al crear/importar proyectos. Los proyectos que
 * ya existen guardan su propio agent/provider/modelo y se editan con
 * `storm project` (o desde "Seleccionar proyecto").
 *
 * Navegación: en CADA pregunta el usuario tiene "← Volver" como opción
 * explícita, y Esc/Ctrl+C también vuelven al menú anterior en vez de
 * cerrar storm. La única salida del wizard es elegir "Volver" en el
 * menú principal del config.
 */

import * as clack from '@clack/prompts';

import {
  readAllConfig,
  setConfigValue,
  setProviderAndModel,
  resetConfig,
  CONFIG_FILE_PATH,
} from '../commands/config.js';
import { AGENTS, detectAgent, installAgent } from '../core/agents.js';
import { pickProvider, pickModel, providerLabel } from './pick-launch.js';
import * as ansi from './ansi.js';
import { platform } from 'node:os';

/** Sentinel value used in submenus for the "go back" option. */
const BACK = '__back__';

/**
 * @param {{cwd: string}} _input
 */
export async function runConfigWizard(_input) {
  clack.intro(ansi.bold('Configuración global'));
  clack.log.info(ansi.dim('Tip: presioná Esc en cualquier momento para cancelar el paso actual.'));

  while (true) {
    const cfg = await readAllConfig();
    showStatus(cfg);

    const action = await clack.select({
      message: '¿Qué querés hacer?',
      options: [
        { value: 'provider',   label: 'Cambiar provider y modelo por defecto' },
        { value: 'agent',      label: 'Cambiar agent por defecto (Claude Code / OpenCode / ...)' },
        { value: 'launchCmd',  label: 'Definir el comando para agents custom' },
        { value: 'ollamaHost', label: 'Cambiar OLLAMA_HOST' },
        { value: 'install',    label: 'Instalar/verificar agent' },
        { value: 'reset',      label: 'Resetear todo a valores por defecto' },
        { value: 'open',       label: 'Mostrar ruta del archivo de config' },
        { value: 'exit',       label: '← Volver al menú principal' },
      ],
    });

    // Cancel here = leave the config wizard back to the main menu.
    if (clack.isCancel(action) || action === 'exit') {
      clack.outro(ansi.dim('Listo.'));
      return;
    }

    try {
      if (action === 'provider')   await editProvider();
      else if (action === 'agent') await editAgent();
      else if (action === 'launchCmd')  await editLaunchCommand();
      else if (action === 'ollamaHost') await editOllamaHost();
      else if (action === 'install')    await runInstallSubmenu();
      else if (action === 'reset')      await runResetConfirm();
      else if (action === 'open') {
        clack.note(
          `${ansi.dim('Editá este archivo a mano si querés cambios avanzados:')}\n  ${ansi.cyan(CONFIG_FILE_PATH)}`,
          'Ruta del config',
        );
      }
    } catch (err) {
      clack.log.error(err.message ?? String(err));
    }
  }
}

// ---------------------------------------------------------------------------
// Sub-flows
// ---------------------------------------------------------------------------

function showStatus(cfg) {
  const lines = [
    `Provider:        ${cfg.defaultProvider?.provider ? ansi.cyan(providerLabel(cfg.defaultProvider.provider)) : ansi.dim('(no seteado)')}`,
    `Modelo:          ${cfg.defaultProvider?.model ? ansi.cyan(cfg.defaultProvider.model) : ansi.dim('(no aplica / no seteado)')}`,
    `Agent:           ${ansi.cyan(cfg.defaultAgent ?? 'claude-code')}`,
    `Comando custom:  ${cfg.defaultLaunchCommand ? ansi.cyan(cfg.defaultLaunchCommand) : ansi.dim('(ninguno)')}`,
    `OLLAMA_HOST:     ${ansi.cyan(cfg.ollamaHost ?? 'http://127.0.0.1:11434')}`,
    '',
    ansi.dim('Defaults para proyectos nuevos y para analizar en `storm import`.'),
    ansi.dim('Para un proyecto existente: `storm project` o "Seleccionar proyecto".'),
  ];
  clack.note(lines.join('\n'), 'Estado actual');
}

async function editProvider() {
  const cur = await readAllConfig();
  const provider = await pickProvider({
    message: 'Provider por defecto (Esc para volver)',
    initialValue: cur.defaultProvider?.provider ?? null,
    suggestFor: cur.defaultAgent ?? 'claude-code',
  });
  if (!provider) return;
  const model = await pickModel(provider, {
    initialValue: provider === cur.defaultProvider?.provider ? cur.defaultProvider.model : null,
  });
  if (!model) return; // Nada se guardó: provider y modelo van juntos.

  await setProviderAndModel(provider, model.name);
  clack.log.success(
    `Provider por defecto: ${ansi.cyan(providerLabel(provider))}${model.name ? ' (' + model.name + ')' : ''}.`,
  );
  clack.log.info(ansi.dim('Los proyectos existentes no cambian. Para eso: `storm project`.'));
}

async function editAgent() {
  const choice = await clack.select({
    message: 'Agent (Esc para volver)',
    options: [
      ...AGENTS.map((a) => ({ value: a.id, label: a.label, hint: a.hint })),
      { value: '__custom__', label: 'Otro... (texto libre)' },
      { value: BACK,         label: '← Volver' },
    ],
  });
  if (clack.isCancel(choice) || choice === BACK) return;

  let agentId = choice;
  if (choice === '__custom__') {
    const c = await clack.text({
      message: 'ID del agent (Esc para volver)',
      placeholder: 'mi-agent',
      validate: (v) => (v?.trim() ? undefined : 'No puede estar vacío'),
    });
    if (clack.isCancel(c)) return;
    agentId = c.trim();
    clack.log.warn(
      'Agent custom: definí también "el comando para agents custom" para que storm sepa cómo lanzarlo.',
    );
  }

  await setConfigValue('agent', agentId);
  clack.log.success(`Agent por defecto: ${ansi.cyan(agentId)}.`);
  clack.log.info(ansi.dim('Los proyectos existentes no cambian. Para eso: `storm project`.'));
}

async function editLaunchCommand() {
  const cur = await readAllConfig();
  const currentValue = cur.defaultLaunchCommand ?? '';

  clack.note(
    [
      'Comando para lanzar agents que storm no conoce (Aider, scripts propios).',
      'Se copia a los proyectos nuevos con agent custom, y se usa en los',
      'proyectos con agent custom que no tengan un comando propio.',
      'Claude Code y OpenCode usan su template y no lo necesitan.',
      '',
      'Usá el placeholder ' + ansi.cyan('{{model}}') + ' donde quieras inyectar el nombre del modelo.',
      '',
      'Ejemplos:',
      ansi.dim('  aider --model {{model}} --no-auto-commits'),
      ansi.dim('  python -m my_agent --provider ollama --model {{model}}'),
      '',
      'Para pisar el comando de UN proyecto: `storm project set launchCommand "..."`.',
      'Dejá vacío para borrarlo.',
      ansi.dim('Esc en cualquier momento para cancelar.'),
    ].join('\n'),
    'Comando custom',
  );

  const cmd = await clack.text({
    message: 'Comando de lanzamiento (Esc para volver)',
    placeholder: 'aider --model {{model}}',
    initialValue: currentValue,
  });
  if (clack.isCancel(cmd)) return;

  const trimmed = cmd?.trim() ?? '';
  await setConfigValue('launchCommand', trimmed.length === 0 ? null : trimmed);
  if (trimmed.length === 0) {
    clack.log.success('Comando custom borrado.');
  } else {
    clack.log.success(`Comando seteado: ${ansi.cyan(trimmed)}`);
  }
}

async function editOllamaHost() {
  const cur = await readAllConfig();
  const host = await clack.text({
    message: 'OLLAMA_HOST (Esc para volver)',
    placeholder: 'http://127.0.0.1:11434',
    initialValue: cur.ollamaHost ?? 'http://127.0.0.1:11434',
    validate: (v) =>
      v?.trim().match(/^https?:\/\//) ? undefined : 'Debe empezar con http:// o https://',
  });
  if (clack.isCancel(host)) return;
  await setConfigValue('ollamaHost', host.trim());
  clack.log.success(`OLLAMA_HOST seteado en ${ansi.cyan(host.trim())}.`);
}

async function runInstallSubmenu() {
  const choice = await clack.select({
    message: '¿Qué agent verificar/instalar? (Esc para volver)',
    options: [
      ...AGENTS.map((a) => ({ value: a.id, label: a.label, hint: a.hint })),
      { value: BACK, label: '← Volver' },
    ],
  });
  if (clack.isCancel(choice) || choice === BACK) return;

  const status = await detectAgent(choice);
  if (status.installed) {
    clack.log.success(
      `${choice} ya está instalado` + (status.version ? ` (${status.version.split('\n')[0]})` : '') + '.',
    );
    return;
  }

  const confirm = await clack.confirm({
    message: `${choice} no está en PATH. ¿Intentar instalarlo?`,
    initialValue: true,
  });
  if (clack.isCancel(confirm) || !confirm) return;

  const spinner = clack.spinner();
  spinner.start(`Instalando ${choice}`);
  const result = await installAgent(choice, platform());
  if (result.ok) {
    spinner.stop(`${choice} instalado`);
  } else {
    spinner.stop(ansi.red(`No se pudo instalar ${choice} automáticamente`));
    if (result.manualUrl) {
      const { openInBrowser } = await import('./open-browser.js');
      const opened = await openInBrowser(result.manualUrl);
      const url = ansi.cyan(result.manualUrl);
      clack.note(
        [
          opened
            ? `Te abrí ${url} en el browser.`
            : `Andá manualmente a:\n  ${url}`,
          '',
          'Instalá la herramienta y volvé a probar `Instalar/verificar agent`.',
        ].join('\n'),
        `Instalación manual de ${choice}`,
      );
    } else {
      clack.log.info(result.message);
    }
  }
}

async function runResetConfirm() {
  const yes = await clack.confirm({
    message: '¿Resetear toda la config global a valores por defecto?',
    initialValue: false,
  });
  if (clack.isCancel(yes) || !yes) return;
  await resetConfig();
  clack.log.success('Config global reseteada.');
}
