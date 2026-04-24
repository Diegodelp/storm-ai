/**
 * Chequeo de primera ejecución.
 *
 * Corre una sola vez por máquina (marcador en ~/.storm-ai/first-run.json).
 * Si Ollama no está instalado, ofrece instalarlo. Se puede saltear —
 * storm funciona sin Ollama si el usuario prefiere la API de Claude.
 */

import * as clack from '@clack/prompts';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import path from 'node:path';

import { detectOllama, installOllama } from '../core/providers.js';
import * as ansi from './ansi.js';

const MARKER_DIR = path.join(homedir(), '.storm-ai');
const MARKER_FILE = path.join(MARKER_DIR, 'first-run.json');

async function isFirstRun() {
  try {
    const raw = await readFile(MARKER_FILE, 'utf8');
    const json = JSON.parse(raw);
    return !json.completed_at;
  } catch {
    return true;
  }
}

async function markFirstRunComplete(status) {
  await mkdir(MARKER_DIR, { recursive: true });
  await writeFile(
    MARKER_FILE,
    JSON.stringify(
      {
        completed_at: new Date().toISOString(),
        ollama_at_first_run: status,
      },
      null,
      2,
    ),
    'utf8',
  );
}

export async function runFirstRunCheckIfNeeded() {
  if (!(await isFirstRun())) return;

  const status = await detectOllama();

  if (status.installed) {
    await markFirstRunComplete({ installed: true, version: status.version });
    return;
  }

  clack.note(
    'storm-ai puede usar Claude Code a través de Ollama con modelos abiertos\n' +
      '(kimi-k2.6:cloud, glm-4.7-flash, qwen3-coder, etc.).\n\n' +
      ansi.dim('No se detectó Ollama en tu sistema.'),
    'Configuración inicial',
  );

  const choice = await clack.select({
    message: '¿Instalar Ollama ahora?',
    options: [
      { value: 'install', label: 'Sí, instalar ahora', hint: 'Corre el instalador oficial' },
      { value: 'skip',    label: 'Más tarde',          hint: 'Podés instalarlo después desde ollama.com' },
      { value: 'never',   label: 'No quiero Ollama',   hint: 'Usar solo Claude API' },
    ],
  });

  if (clack.isCancel(choice) || choice === 'skip') {
    // No marcamos completado — vuelve a preguntar en el próximo arranque.
    return;
  }

  if (choice === 'never') {
    await markFirstRunComplete({ installed: false, declined: true });
    return;
  }

  // Flujo de instalación.
  const plat = platform();
  if (plat === 'win32') {
    clack.note(
      'En Windows hay que descargar el instalador desde:\n' +
        ansi.cyan('https://ollama.com/download') +
        '\n\nDespués de instalarlo, reiniciá la terminal y corré ' +
        ansi.cyan('storm') +
        ' de nuevo.',
      'Instalación manual',
    );
    return;
  }

  const spinner = clack.spinner();
  spinner.start('Instalando Ollama (puede tardar un minuto)');
  const result = await installOllama(plat);
  if (result.ok) {
    spinner.stop('Ollama instalado');
    const verify = await detectOllama();
    await markFirstRunComplete({ installed: verify.installed, version: verify.version });
  } else {
    spinner.stop(ansi.red('Falló la instalación'));
    clack.log.error(result.message);
  }
}
