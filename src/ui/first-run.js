/**
 * Chequeo de primera ejecución.
 *
 * Corre una sola vez por máquina (marcador en ~/.storm-ai/first-run.json).
 * Verifica los requisitos del sistema:
 *   - node       (debería estar — sin esto storm no arranca)
 *   - git        (necesario para `storm new --template`)
 *   - ollama     (opcional, pero recomendado)
 *
 * Para cada uno que falte, ofrece instalar (donde sea posible) o
 * muestra cómo instalarlo manualmente.
 *
 * Es saltable: el usuario puede decir "más tarde" y storm sigue. La
 * ausencia de un requisito solo da error cuando se intenta usar la
 * feature que lo necesita (ej. `storm new --template` sin git).
 */

import * as clack from '@clack/prompts';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import path from 'node:path';

import { detectOllama, installOllama } from '../core/providers.js';
import {
  detectGit,
  detectNode,
  detectNpm,
  installGit,
  installNodeHint,
} from '../core/requirements.js';
import { openInBrowser } from './open-browser.js';
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
        environment_at_first_run: status,
      },
      null,
      2,
    ),
    'utf8',
  );
}

export async function runFirstRunCheckIfNeeded() {
  if (!(await isFirstRun())) return;

  const plat = platform();

  // Check all requirements concurrently.
  const [node, npm, git, ollama] = await Promise.all([
    detectNode(),
    detectNpm(),
    detectGit(),
    detectOllama(),
  ]);

  // Build a status table for the user.
  const lines = [
    statusLine('Node.js', node.installed, node.version),
    statusLine('npm',     npm.installed,  npm.version),
    statusLine('git',     git.installed,  git.version),
    statusLine('Ollama',  ollama.installed, ollama.version, '(opcional)'),
  ];
  clack.note(lines.join('\n'), 'Chequeo de requisitos');

  const allInstalled = node.installed && npm.installed && git.installed && ollama.installed;
  if (allInstalled) {
    await markFirstRunComplete({
      node: node.version,
      npm: npm.version,
      git: git.version,
      ollama: ollama.version,
    });
    return;
  }

  // Prompt for missing ones, in the order: node, git, ollama.
  // (Skip if already installed.)
  if (!node.installed) {
    const hint = installNodeHint(plat);
    clack.log.warn(`Node.js falta. ${hint.message}`);
  }

  if (!git.installed) {
    const choice = await clack.select({
      message: 'git no está instalado (necesario para los templates). ¿Instalarlo?',
      options: [
        { value: 'install', label: 'Sí, instalar ahora' },
        { value: 'skip',    label: 'Más tarde' },
        { value: 'never',   label: 'No lo voy a usar' },
      ],
    });

    if (clack.isCancel(choice) || choice === 'skip') {
      return; // Don't mark complete — we'll ask again next run.
    }

    if (choice === 'install') {
      // installGit tries the platform's package manager:
      //   - Linux:   apt/dnf/yum/pacman/apk
      //   - macOS:   Homebrew (or Xcode CLT hint)
      //   - Windows: winget
      const result = await installGit(plat);
      if (result.ok) {
        clack.log.success('git instalado.');
      } else {
        clack.log.error('No se pudo instalar git automáticamente.');
        clack.log.info(result.message);
        // Fallback: open the download page.
        const fallback = await clack.confirm({
          message: '¿Abrir la página de descarga manual?',
          initialValue: true,
        });
        if (!clack.isCancel(fallback) && fallback) {
          await openInBrowser(result.manualUrl ?? 'https://git-scm.com/download');
        }
      }
    }
  }

  if (!ollama.installed) {
    const choice = await clack.select({
      message: 'Ollama no está instalado (recomendado para usar modelos open). ¿Instalarlo?',
      options: [
        { value: 'install', label: 'Sí, instalar ahora' },
        { value: 'skip',    label: 'Más tarde' },
        { value: 'never',   label: 'No lo voy a usar (usar solo Claude API)' },
      ],
    });

    if (clack.isCancel(choice) || choice === 'skip') {
      return;
    }

    if (choice === 'install') {
      // installOllama runs the official installer for the current OS:
      //   - Linux/macOS: curl ... | sh
      //   - Windows:     PowerShell with `irm https://ollama.com/install.ps1 | iex`
      // It prints progress to the user's terminal directly.
      clack.log.info('Iniciando el instalador de Ollama. Puede tardar varios minutos.');
      const result = await installOllama(plat);
      if (result.ok) {
        clack.log.success('Ollama instalado.');
        if (plat === 'win32') {
          clack.note(
            'Cerrá esta terminal y abrí una nueva para que el comando ' +
              ansi.cyan('ollama') +
              ' esté disponible. Después corré ' + ansi.cyan('storm') + ' otra vez.',
            'Importante',
          );
        }
      } else {
        clack.log.error('Falló la instalación automática.');
        clack.log.info(result.message);
        // Fallback: offer to open the download page.
        const fallback = await clack.confirm({
          message: '¿Abrir la página de descarga manual?',
          initialValue: true,
        });
        if (!clack.isCancel(fallback) && fallback) {
          await openInBrowser('https://ollama.com/download');
        }
        return;
      }
    }
  }

  // Re-check status to record the final state.
  const [g2, o2] = await Promise.all([detectGit(), detectOllama()]);
  await markFirstRunComplete({
    node: node.version,
    npm: npm.version,
    git: g2.version,
    ollama: o2.version,
  });
}

function statusLine(name, installed, version, suffix = '') {
  const icon = installed ? ansi.green('✓') : ansi.red('✗');
  const ver = installed && version ? ansi.dim(version.split('\n')[0]) : ansi.dim('no instalado');
  const tag = suffix ? ' ' + ansi.dim(suffix) : '';
  return `  ${icon}  ${name.padEnd(8)} ${ver}${tag}`;
}
