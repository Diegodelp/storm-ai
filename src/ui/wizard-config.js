/**
 * Wizard interactivo para `storm config`.
 *
 * Muestra el estado actual de la configuración global y permite
 * editar cada campo. La configuración vive en ~/.storm-ai/config.json
 * (la ruta exacta se muestra al final).
 *
 * Campos que se pueden modificar:
 *   - Provider por defecto       (ollama-cloud | ollama-local | claude)
 *   - Modelo por defecto         (cambia según el provider)
 *   - Agent por defecto          (claude-code | opencode | custom)
 *   - Launch command custom      (override total para usuarios avanzados)
 *   - OLLAMA_HOST                (URL del daemon Ollama)
 */

import * as clack from '@clack/prompts';

import {
  readAllConfig,
  setConfigValue,
  resetConfig,
  CONFIG_FILE_PATH,
} from '../commands/config.js';
import { CLOUD_MODELS, LOCAL_RECOMMENDED, detectOllama } from '../core/providers.js';
import { AGENTS, detectAgent, installAgent } from '../core/agents.js';
import * as ansi from './ansi.js';
import { platform } from 'node:os';

/**
 * @param {{cwd: string}} _input
 */
export async function runConfigWizard(_input) {
  clack.intro(ansi.bold('Configuración global'));

  while (true) {
    const cfg = await readAllConfig();
    showStatus(cfg);

    const action = await clack.select({
      message: '¿Qué querés hacer?',
      options: [
        { value: 'provider',     label: 'Cambiar provider y modelo por defecto' },
        { value: 'agent',        label: 'Cambiar agent por defecto (Claude Code / OpenCode / ...)' },
        { value: 'launchCmd',    label: 'Definir un comando de lanzamiento custom' },
        { value: 'ollamaHost',   label: 'Cambiar OLLAMA_HOST' },
        { value: 'install',      label: 'Instalar/verificar agent' },
        { value: 'reset',        label: 'Resetear todo a valores por defecto' },
        { value: 'open',         label: 'Mostrar ruta del archivo de config' },
        { value: 'exit',         label: 'Volver' },
      ],
    });
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
    `Provider:        ${ansi.cyan(cfg.defaultProvider?.provider ?? '(no seteado)')}`,
    `Modelo:          ${ansi.cyan(cfg.defaultProvider?.model ?? '(no seteado)')}`,
    `Agent:           ${ansi.cyan(cfg.defaultAgent ?? 'claude-code')}`,
    `Launch custom:   ${cfg.defaultLaunchCommand ? ansi.cyan(cfg.defaultLaunchCommand) : ansi.dim('(usa template del agent)')}`,
    `OLLAMA_HOST:     ${ansi.cyan(cfg.ollamaHost ?? 'http://127.0.0.1:11434')}`,
  ];
  clack.note(lines.join('\n'), 'Estado actual');
}

async function editProvider() {
  const provider = await clack.select({
    message: 'Provider',
    options: [
      { value: 'ollama-cloud', label: 'Ollama (cloud)', hint: 'Modelos hosteados, gratis con login' },
      { value: 'ollama-local', label: 'Ollama (local)', hint: 'Modelos en tu máquina' },
      { value: 'claude',       label: 'Claude API',     hint: 'Anthropic, requiere ANTHROPIC_API_KEY' },
    ],
  });
  if (clack.isCancel(provider)) return;
  await setConfigValue('provider', provider);

  // Now pick a model that fits the provider.
  let model = null;
  if (provider === 'ollama-cloud') {
    const choice = await clack.select({
      message: 'Modelo cloud',
      options: [
        ...CLOUD_MODELS.map((m) => ({ value: m.name, label: m.label, hint: m.hint })),
        { value: '__custom__', label: 'Custom...' },
      ],
    });
    if (clack.isCancel(choice)) return;
    if (choice === '__custom__') {
      const c = await clack.text({
        message: 'Nombre del modelo (debe terminar en :cloud)',
        validate: (v) => v?.trim().endsWith(':cloud') ? undefined : 'Modelos cloud terminan en :cloud',
      });
      if (clack.isCancel(c)) return;
      model = c.trim();
    } else {
      model = choice;
    }
  } else if (provider === 'ollama-local') {
    const choice = await clack.select({
      message: 'Modelo local',
      options: [
        ...LOCAL_RECOMMENDED.map((m) => ({ value: m.name, label: m.label, hint: m.hint })),
        { value: '__custom__', label: 'Custom...' },
      ],
    });
    if (clack.isCancel(choice)) return;
    if (choice === '__custom__') {
      const c = await clack.text({ message: 'Nombre del modelo local' });
      if (clack.isCancel(c)) return;
      model = c.trim();
    } else {
      model = choice;
    }
  } else {
    // Claude API: no model picker (CLI decides).
    model = null;
  }

  await setConfigValue('model', model);
  clack.log.success(`Provider seteado en ${ansi.cyan(provider)}${model ? ' (' + model + ')' : ''}.`);
}

async function editAgent() {
  const choice = await clack.select({
    message: 'Agent',
    options: [
      ...AGENTS.map((a) => ({ value: a.id, label: a.label, hint: a.hint })),
      { value: '__custom__', label: 'Otro... (texto libre)' },
    ],
  });
  if (clack.isCancel(choice)) return;

  let agentId = choice;
  if (choice === '__custom__') {
    const c = await clack.text({
      message: 'ID del agent (libre)',
      placeholder: 'mi-agent',
      validate: (v) => (v?.trim() ? undefined : 'No puede estar vacío'),
    });
    if (clack.isCancel(c)) return;
    agentId = c.trim();
    clack.log.warn(
      'Agent custom: tenés que setear `launchCommand` para que storm sepa cómo lanzarlo.',
    );
  }

  await setConfigValue('agent', agentId);
  clack.log.success(`Agent seteado en ${ansi.cyan(agentId)}.`);
}

async function editLaunchCommand() {
  const cur = await readAllConfig();
  const currentValue = cur.defaultLaunchCommand ?? '';

  clack.note(
    [
      'Si seteás un comando custom, sobrescribe el template del agent.',
      'Usá el placeholder ' + ansi.cyan('{{model}}') + ' donde quieras inyectar el nombre del modelo.',
      '',
      'Ejemplos:',
      ansi.dim('  ollama launch claude --model {{model}}'),
      ansi.dim('  ollama launch opencode --model {{model}}'),
      ansi.dim('  aider --model {{model}} --no-auto-commits'),
      ansi.dim('  python -m my_agent --provider ollama --model {{model}}'),
      '',
      'Para volver al template del agent (no usar comando custom), dejá vacío.',
    ].join('\n'),
    'Comando custom',
  );

  const cmd = await clack.text({
    message: 'Comando de lanzamiento',
    placeholder: 'ollama launch opencode --model {{model}}',
    initialValue: currentValue,
  });
  if (clack.isCancel(cmd)) return;

  const trimmed = cmd?.trim() ?? '';
  await setConfigValue('launchCommand', trimmed.length === 0 ? null : trimmed);
  if (trimmed.length === 0) {
    clack.log.success('Comando custom borrado. Storm va a usar el template del agent.');
  } else {
    clack.log.success(`Comando seteado: ${ansi.cyan(trimmed)}`);
  }
}

async function editOllamaHost() {
  const cur = await readAllConfig();
  const host = await clack.text({
    message: 'OLLAMA_HOST',
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
    message: '¿Qué agent verificar/instalar?',
    options: AGENTS.map((a) => ({ value: a.id, label: a.label, hint: a.hint })),
  });
  if (clack.isCancel(choice)) return;

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
