/**
 * Menú interactivo principal.
 *
 * Responsivo: el logo, las instrucciones, el menú y el footer se
 * redibujan cuando la terminal cambia de tamaño (ver picker.js).
 *
 * Layout:
 *   - Logo half-blocks centrado (80 cols).
 *   - Texto "Usa ↑ ↓ y ENTER." centrado.
 *   - Menú con picker custom, ítems centrados, highlight con `>`.
 *   - Footer abajo: "STORM CLI v0.1.0  ...  https://storm-ai-dev.vercel.app/"
 */

import * as clack from '@clack/prompts';
import process from 'node:process';

import { renderLogo, renderFooter } from './logo.js';
import { runNewWizard } from './wizard-new.js';
import { runOpenWizard } from './wizard-open.js';
import { runFirstRunCheckIfNeeded } from './first-run.js';
import { install as installCmd } from '../commands/install.js';
import { pick } from './picker.js';
import * as ansi from './ansi.js';
import { centerLine, centerBlock, termWidth, termHeight, horizontalRule } from './layout.js';

const VERSION = '0.1.0';

function moveCursor(row, col = 1) {
  process.stdout.write(`\x1b[${row};${col}H`);
}

/**
 * Construye una función que pinta el header (logo + instrucciones).
 * La función no es async — llama una versión cacheada del logo.
 *
 * @param {string} cachedLogo
 */
function makeHeaderRenderer(cachedLogo) {
  return () => {
    const width = termWidth();
    process.stdout.write('\n');
    process.stdout.write(centerBlock(cachedLogo, width));
    process.stdout.write('\n\n');
    process.stdout.write(
      centerLine(
        `Usa ${ansi.magenta('↑')} ${ansi.magenta('↓')} y ENTER.`,
        width,
      ),
    );
    process.stdout.write('\n\n');
  };
}

function makeFooterRenderer() {
  return () => {
    const width = termWidth();
    const height = termHeight();
    if (height < 8) return;

    const left = ansi.cyan(' STORM CLI') + '   ' + ansi.dim('v' + VERSION);
    const right = ansi.dim('https://storm-ai-dev.vercel.app/');
    const visibleLen = (s) => ansi.stripAnsi(s).length;
    const gap = Math.max(2, width - visibleLen(left) - visibleLen(right));
    const line = left + ' '.repeat(gap) + right;

    // Save cursor, jump to footer, write, restore cursor.
    process.stdout.write('\x1b[s');
    moveCursor(height - 1, 1);
    process.stdout.write(ansi.dim(horizontalRule('─', width)));
    moveCursor(height, 1);
    process.stdout.write(line);
    process.stdout.write('\x1b[u');
  };
}

export async function runInteractiveMenu({ cwd }) {
  // Render logo una vez (async, pero se cachea internamente).
  let cachedLogo;
  try {
    cachedLogo = await renderLogo();
  } catch {
    cachedLogo = 'STORM';
  }

  // First run: clack imprime arriba. Lo hacemos antes del picker así no
  // se mezcla con el loop responsivo.
  process.stdout.write('\x1bc');
  await runFirstRunCheckIfNeeded();

  const options = [
    { value: 'new',     label: 'Crear proyecto' },
    { value: 'open',    label: 'Seleccionar proyecto' },
    { value: 'import',  label: 'Importar proyecto existente' },
    { value: 'install', label: 'Instalar acceso storm en Escritorio' },
    { value: 'exit',    label: 'Salir' },
  ];

  const longest = Math.max(...options.map((o) => o.label.length));
  const blockWidth = longest + 2; // "> " prefix

  const repaintHeader = makeHeaderRenderer(cachedLogo);
  const repaintFooter = makeFooterRenderer();
  const computeIndent = (w) => Math.max(0, Math.floor((w - blockWidth) / 2));

  while (true) {
    const choice = await pick({
      options,
      repaintHeader,
      repaintFooter,
      computeIndent,
      initialIndex: 0,
    });

    if (choice === null || choice === 'exit') {
      process.stdout.write('\n');
      process.stdout.write(
        centerLine(renderFooter({ version: VERSION }), termWidth()),
      );
      process.stdout.write('\n\n');
      process.stdout.write(centerLine(ansi.dim('Hasta luego.'), termWidth()));
      process.stdout.write('\n');
      return;
    }

    // Al entrar a un sub-wizard dejamos que clack tome el control.
    // Clack imprime lineal (no responsivo), así que limpiamos la pantalla.
    process.stdout.write('\x1bc');

    try {
      if (choice === 'new') {
        await runNewWizard({ cwd });
      } else if (choice === 'open') {
        await runOpenWizard({ cwd });
      } else if (choice === 'import') {
        const { runImportWizard } = await import('./wizard-import.js');
        await runImportWizard({ cwd });
      } else if (choice === 'install') {
        const spinner = clack.spinner();
        spinner.start('Instalando acceso directo');
        const result = await installCmd({});
        spinner.stop('Instalación completa');
        for (const c of result?.created ?? []) {
          console.log('  ' + ansi.dim(c));
        }
        for (const w of result?.warnings ?? []) {
          console.log(ansi.yellow('  ⚠ ' + w));
        }
        if (result?.nextSteps?.length) {
          clack.note(result.nextSteps.join('\n'), 'Próximos pasos');
        }
      }
    } catch (err) {
      clack.log.error(err?.message ?? String(err));
      if (process.env.STORM_DEBUG) {
        console.error(err?.stack);
      }
    }

    // Pausa breve antes de volver al menú principal, así el usuario
    // ve el resultado antes de que limpiemos la pantalla.
    await new Promise((r) => setTimeout(r, 250));
  }
}
