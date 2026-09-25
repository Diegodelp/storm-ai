/**
 * CLI router.
 *
 * Two modes:
 *   - No arguments          → launch the interactive menu (ui/menu.js).
 *   - Subcommand + args     → execute directly, print results, exit.
 *
 * Direct mode is what scripts and power users want. Menu mode is what
 * a newcomer sees the first time they type `storm`.
 *
 * We intentionally keep this file thin: parse args, route, format output.
 * All business logic is in src/commands/*.
 */

import { Command } from 'commander';
import process from 'node:process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import * as taskCmd from './commands/task.js';
import * as branchCmd from './commands/branch.js';
import * as skillCmd from './commands/skill.js';
import { createProject } from './commands/new.js';
import { refresh as refreshCmd } from './commands/refresh.js';
import { discover as discoverProjects, resolveTarget } from './commands/open.js';
import { install as installCmd } from './commands/install.js';
import { launch as launchCmd } from './commands/launch.js';
import { sync as syncCmd } from './commands/sync.js';

import { runInteractiveMenu } from './ui/menu.js';
import { runNewWizard } from './ui/wizard-new.js';
import { runSkillAddWizard } from './ui/wizard-skill.js';
import { runImportWizard } from './ui/wizard-import.js';
import * as ansi from './ui/ansi.js';
import { getVersion } from './core/version.js';

/**
 * Commander option callback: appends each --flag value to an array.
 * Use as `.option('--branch <path>', '...', collect, [])`.
 */
function collect(value, previous) {
  return [...(previous ?? []), value];
}

export async function runCli(argv) {
  // No args → interactive menu. This is the entry point for most users.
  if (argv.length <= 2) {
    return runInteractiveMenu({ cwd: process.cwd() });
  }

  const program = new Command();
  program
    .name('storm')
    .description('Context-aware project scaffolding for AI coding agents.')
    .version(getVersion())
    .showHelpAfterError();

  // -------------------------------------------------------------------------
  // storm new [name]
  // -------------------------------------------------------------------------
  program
    .command('new [name]')
    .description('Create a new project. Runs the wizard if name is omitted.')
    .option('-d, --description <text>', 'Project description')
    .option('-s, --stack <text>', 'Stack (e.g. "Next.js + Prisma")')
    .option('--db <text>', 'Database description')
    .option('--template <id>', 'Use a template from the registry')
    .option('--agent <id>', 'Agent (CLI): claude-code | opencode | <custom>. Default: storm config.')
    .option('--provider <id>', 'Provider to launch the agent with. Default: storm config (if compatible).')
    .option('--model <name>', 'Model for ollama-* providers (e.g. kimi-k2.6:cloud).')
    .option('--launch-command <cmd>', 'Custom launch command ({{model}} placeholder). Required for custom agents.')
    .option('--force', 'Overwrite if the directory exists')
    .action(async (name, opts) => {
      if (opts.template) {
        // Direct template flow with optional name.
        const { runNewFromTemplateWizard } = await import('./ui/wizard-new-template.js');
        await runNewFromTemplateWizard({
          cwd: process.cwd(),
          templateId: opts.template,
          name: name || null,
        });
        return;
      }

      if (!name) {
        // Name omitted → prompt the user with the full wizard.
        await runNewWizard({ cwd: process.cwd() });
        return;
      }
      if (opts.model && !opts.provider) {
        console.error(ansi.red('error: ') + '--model necesita --provider.');
        process.exitCode = 1;
        return;
      }
      let result;
      try {
        result = await createProject({
          name,
          parentDir: process.cwd(),
          description: opts.description,
          stack: opts.stack,
          database: opts.db,
          agent: opts.agent,
          model: opts.provider ? { provider: opts.provider, name: opts.model ?? null } : undefined,
          launch: opts.launchCommand ? { customCommand: opts.launchCommand } : undefined,
          force: !!opts.force,
        });
      } catch (err) {
        console.error(ansi.red('error: ') + (err.message ?? String(err)));
        process.exitCode = 1;
        return;
      }
      console.log(ansi.green('✓') + ' Created project ' + ansi.bold(result.safeName));
      console.log('  ' + ansi.dim(result.projectRoot));
      if (result.warnings.length) {
        for (const w of result.warnings) console.log(ansi.yellow('  ⚠ ' + w));
      }
      console.log('\nNext: ' + ansi.cyan(`storm open ${result.safeName}`) +
        ansi.dim('   (or: cd ' + result.safeName + ' && storm launch)'));
    });

  // -------------------------------------------------------------------------
  // storm task <action> ...
  // -------------------------------------------------------------------------
  const task = program
    .command('task')
    .description('Manage tasks.');

  task
    .command('add <title>')
    .description('Add a new task.')
    .option('-d, --description <text>')
    .option('-b, --branch <branch...>', 'One or more branch paths')
    .action(async (title, opts) => {
      const r = await taskCmd.add({
        cwd: process.cwd(),
        title,
        description: opts.description,
        branches: opts.branch ?? [],
      });
      console.log(ansi.green('✓') + ` ${r.task.id}  ${r.task.title}`);
      if (r.task.branches.length) {
        console.log(ansi.dim('  branches: ' + r.task.branches.join(', ')));
      }
    });

  task
    .command('start <id>')
    .description('Mark task as in_progress.')
    .action(async (id) => {
      const r = await taskCmd.start({ cwd: process.cwd(), id });
      console.log(ansi.cyan('▶') + ` ${r.task.id}  ${r.task.title}`);
      if (r.task.branches.length) {
        console.log(
          ansi.dim('  load branches: ' + r.task.branches.join(', ')),
        );
      }
    });

  task
    .command('done <id>')
    .description('Mark task as done.')
    .action(async (id) => {
      const r = await taskCmd.done({ cwd: process.cwd(), id });
      console.log(ansi.green('✓') + ` ${r.task.id}  ${r.task.title}`);
      if (r.shouldRefresh) {
        console.log(
          '\n' + ansi.yellow('⚠') + ' Auto-refresh threshold reached. Run ' +
            ansi.cyan('storm refresh') + ' to update compact context.',
        );
      }
    });

  task
    .command('cancel <id>')
    .description('Mark task as cancelled.')
    .action(async (id) => {
      const r = await taskCmd.cancel({ cwd: process.cwd(), id });
      console.log(ansi.dim('✗') + ` ${r.task.id}  ${r.task.title}`);
    });

  task
    .command('note <id> <content>')
    .description('Append a note to a task.')
    .action(async (id, content) => {
      await taskCmd.note({ cwd: process.cwd(), id, content });
      console.log(ansi.green('✓') + ` note added to ${id}`);
    });

  task
    .command('list')
    .description('List tasks, grouped by status.')
    .option('-s, --status <status>', 'Filter by status')
    .option('-b, --branch <path>', 'Filter by branch')
    .action(async (opts) => {
      const r = await taskCmd.list({
        cwd: process.cwd(),
        status: opts.status,
        branch: opts.branch,
      });
      if (r.tasks.length === 0) {
        console.log(ansi.dim('No tasks match.'));
        return;
      }
      const byStatus = group(r.tasks, (t) => t.status);
      for (const [status, items] of byStatus) {
        console.log(ansi.bold(`\n${status}`) + ansi.dim(` (${items.length})`));
        for (const t of items) {
          const branches = t.branches.length ? ansi.dim(`  [${t.branches.join(', ')}]`) : '';
          console.log(`  ${t.id}  ${t.title}${branches}`);
        }
      }
      console.log(
        '\n' +
          ansi.dim(
            `${r.totalCount} total | ${r.counters.done_since_refresh}/${r.counters.auto_refresh_threshold} until refresh`,
          ),
      );
    });

  // -------------------------------------------------------------------------
  // storm refresh
  // -------------------------------------------------------------------------
  program
    .command('refresh')
    .description('Regenerate .context-compact/ (branches + function index; the AI classifies only new/changed functions).')
    .option('--no-llm', 'Do not call the AI: new functions are classified by path only.')
    .action(async (opts) => {
      const r = await refreshCmd({
        cwd: process.cwd(),
        llm: opts.llm !== false,
        onProgress: (done, total) => {
          if (process.stdout.isTTY) process.stdout.write(`\r  clasificando funciones con IA: ${done}/${total}   `);
        },
      });
      if (process.stdout.isTTY) process.stdout.write('\r\x1b[K');
      console.log(
        ansi.green('✓') +
          ` refreshed ${r.branchesWritten} branch(es), ${r.filesScanned} file(s)`,
      );
      const f = r.functions;
      if (f) {
        console.log(
          `  ${f.total} función(es) en ${f.sections} sección(es)` +
            ansi.dim(` (+${f.added} nuevas, -${f.removed} borradas, ${f.classified} clasificadas por IA` +
              (f.pending ? `, ${f.pending} pendientes` : '') + ')'),
        );
      }
      if (r.unassignedCount > 0) {
        console.log(
          ansi.yellow('  ⚠') + ` ${r.unassignedCount} file(s) in _unassigned`,
        );
      }
      for (const w of r.warnings) console.log(ansi.dim('  ' + w));
    });

  // -------------------------------------------------------------------------
  // storm branch <action> ...
  // -------------------------------------------------------------------------
  const branch = program
    .command('branch')
    .description('Manage declared branches.');

  branch
    .command('list')
    .description('List declared branches.')
    .action(async () => {
      const r = await branchCmd.list({ cwd: process.cwd() });
      if (r.branches.length === 0) {
        console.log(ansi.dim('No branches declared.'));
        return;
      }
      for (const b of r.branches) {
        const pins = b.pinned?.length ? ansi.dim(`  pinned: ${b.pinned.join(', ')}`) : '';
        console.log(`  ${ansi.cyan(b.path)}  ${ansi.dim(b.description || '')}${pins}`);
      }
    });

  branch
    .command('add <path>')
    .description('Add a new branch.')
    .option('-d, --description <text>')
    .action(async (p, opts) => {
      const r = await branchCmd.add({
        cwd: process.cwd(),
        path: p,
        description: opts.description,
      });
      console.log(ansi.green('✓') + ` added branch ${ansi.cyan(r.branch)}`);
    });

  branch
    .command('remove <path>')
    .description('Remove a branch.')
    .action(async (p) => {
      const r = await branchCmd.remove({ cwd: process.cwd(), path: p });
      console.log(ansi.green('✓') + ` removed branch ${ansi.cyan(r.branch)}`);
      for (const w of r.warnings) console.log(ansi.yellow('  ⚠ ' + w));
    });

  branch
    .command('pin <path> <files...>')
    .description('Pin one or more files to the top of a branch.')
    .action(async (p, files) => {
      const r = await branchCmd.pin({ cwd: process.cwd(), path: p, files });
      console.log(ansi.green('✓') + ` pinned in ${r.branch}: ${r.pinned.join(', ')}`);
    });

  branch
    .command('unpin <path> <files...>')
    .description('Remove pins from a branch.')
    .action(async (p, files) => {
      const r = await branchCmd.unpin({ cwd: process.cwd(), path: p, files });
      console.log(
        ansi.green('✓') + ` unpinned in ${r.branch}. Remaining: ${r.pinned.join(', ') || '(none)'}`,
      );
    });

  // -------------------------------------------------------------------------
  // storm open [name]
  // -------------------------------------------------------------------------
  program
    .command('open [target]')
    .description('Abre un proyecto: sin <target> lista los disponibles, con <target> lanza el agent.')
    .option('--print', 'Solo imprimir la ruta, no lanzar el agent.')
    .action(async (target, opts) => {
      if (!target) {
        const found = await discoverProjects({});
        if (found.length === 0) {
          console.log(ansi.dim('No storm projects found in default search paths.'));
          return;
        }
        for (const p of found) {
          console.log(`  ${ansi.cyan(p.name)}  ${ansi.dim(p.root)}`);
        }
        console.log(
          '\n' + ansi.dim('Usage:  storm open <name>           launches the configured agent'),
        );
        console.log(
          ansi.dim('        storm open <name> --print   only prints the path'),
        );
        return;
      }
      const root = await resolveTarget({ cwd: process.cwd(), target });

      if (opts.print) {
        // Just print the path — useful for shell snippets like
        //   cd "$(storm open my-app --print)"
        console.log(root);
        return;
      }

      // Default: actually launch the configured agent in that project.
      console.log(ansi.green('✓') + ` Opening ${ansi.cyan(root)}`);
      try {
        const { launchForProject } = await import('./commands/launch.js');
        await launchForProject({ projectRoot: root });
      } catch (err) {
        console.error(ansi.red('error: ') + (err.message ?? String(err)));
        console.error(ansi.dim('To get just the path, use:  storm open ' + target + ' --print'));
        process.exitCode = 1;
      }
    });

  // -------------------------------------------------------------------------
  // storm functions — function index (#ID → file:lines, by section)
  // -------------------------------------------------------------------------
  const fnCmd = program
    .command('functions')
    .description('Query the function index (IDs, sections). Updated by `storm refresh`.');

  fnCmd
    .command('show <id>')
    .description('Print the exact code of one function: storm functions show ID-001')
    .action(async (id) => {
      try {
        const { showFunction } = await import('./commands/functions.js');
        const r = await showFunction({ cwd: process.cwd(), id });
        const e = r.entry;
        console.log(ansi.bold(`#${e.id} ${e.name}`) + ansi.dim(`  ${e.layer} · ${e.section}`));
        console.log(ansi.dim(`${e.file}:${r.start}-${r.end}`) +
          (r.moved ? ansi.yellow('  (líneas actualizadas; corré `storm refresh`)') : ''));
        if (e.description) console.log(ansi.dim(e.description));
        console.log('');
        console.log(r.code);
      } catch (err) {
        console.error(ansi.red('error: ') + err.message);
        process.exitCode = 1;
      }
    });

  fnCmd
    .command('list [filter]')
    .description('List functions, optionally filtered by text (layer, section, name, file).')
    .action(async (filter) => {
      try {
        const { listFunctions } = await import('./commands/functions.js');
        const fns = await listFunctions({ cwd: process.cwd(), filter });
        if (fns.length === 0) {
          console.log(ansi.dim('Sin funciones. Corré `storm refresh` para generar el índice.'));
          return;
        }
        for (const f of fns) {
          const desc = f.description ? ansi.dim(` — ${f.description}`) : '';
          console.log(`${ansi.cyan('#' + f.id)} ${f.name}${desc}  ${ansi.dim(`${f.layer}/${f.section} · ${f.file}:${f.start}`)}`);
        }
        console.log(ansi.dim(`\n${fns.length} función(es).`));
      } catch (err) {
        console.error(ansi.red('error: ') + err.message);
        process.exitCode = 1;
      }
    });

  // -------------------------------------------------------------------------
  // storm launch
  // -------------------------------------------------------------------------
  program
    .command('launch')
    .description("Launch the project's agent with its provider/model (see `storm project`).")
    .action(async () => {
      await launchCmd({ cwd: process.cwd() });
    });

  // -------------------------------------------------------------------------
  // storm sync
  // -------------------------------------------------------------------------
  program
    .command('sync')
    .description('Detect new branches on disk and update project.config.json.')
    .option('--no-regenerate', 'Skip regenerating .context-compact/ files')
    .action(async (opts) => {
      const report = await syncCmd({
        cwd: process.cwd(),
        regenerate: opts.regenerate !== false,
      });
      if (report.added.length === 0 && report.markedStale.length === 0 && report.clearedStale.length === 0) {
        console.log(ansi.dim('Sin cambios. La configuración refleja el filesystem.'));
      } else {
        if (report.added.length) {
          console.log(ansi.green('✓') + ` ${report.added.length} rama(s) nueva(s):`);
          for (const b of report.added) {
            const desc = b.description ? ansi.dim(' — ' + b.description) : '';
            console.log('  ' + ansi.cyan(b.path) + desc);
          }
        }
        if (report.clearedStale.length) {
          console.log(ansi.green('✓') + ' ramas reactivadas:');
          for (const b of report.clearedStale) console.log('  ' + ansi.cyan(b.path));
        }
        if (report.markedStale.length) {
          console.log(ansi.yellow('⚠') + ' ramas sin archivos (marcadas stale):');
          for (const b of report.markedStale) console.log('  ' + ansi.dim(b.path));
        }
      }
      for (const w of report.warnings) console.log(ansi.yellow('  ⚠ ' + w));
    });

  // -------------------------------------------------------------------------
  // storm skill
  // -------------------------------------------------------------------------
  const skill = program
    .command('skill')
    .description('Manage per-project skills.');

  skill
    .command('add [name]')
    .description('Add a custom skill. With no name, opens an interactive wizard.')
    .option('-d, --description <text>', 'One-line description')
    .option('-b, --branch <path...>', 'Branches this skill is associated with')
    .action(async (name, opts) => {
      if (!name) {
        await runSkillAddWizard({ cwd: process.cwd() });
        return;
      }
      const { requireProjectRoot } = await import('./core/paths.js');
      const projectRoot = await requireProjectRoot(process.cwd());
      const r = await skillCmd.addSkill({
        cwd: process.cwd(),
        projectRoot,
        name,
        description: opts.description,
        branches: opts.branch ?? [],
      });
      console.log(ansi.green('✓') + ` ${r.created ? 'creada' : 'ya existía'}: ${ansi.cyan(r.slug)}`);
      console.log('  ' + ansi.dim(r.file));
    });

  skill
    .command('list')
    .description('List all skills (built-in and custom).')
    .action(async () => {
      const { requireProjectRoot } = await import('./core/paths.js');
      const projectRoot = await requireProjectRoot(process.cwd());
      const skills = await skillCmd.listSkills({ projectRoot });
      if (skills.length === 0) {
        console.log(ansi.dim('Sin skills configuradas.'));
        return;
      }
      for (const s of skills) {
        const tag = s.builtin ? ansi.dim('[built-in]') : ansi.cyan('[custom]');
        const desc = s.description ? ' — ' + ansi.dim(s.description) : '';
        console.log(`  ${tag}  ${ansi.bold(s.name)}${desc}`);
      }
    });

  skill
    .command('remove <name>')
    .description('Remove a custom skill (built-in skills are protected).')
    .action(async (name) => {
      const { requireProjectRoot } = await import('./core/paths.js');
      const projectRoot = await requireProjectRoot(process.cwd());
      const r = await skillCmd.removeSkill({ projectRoot, name });
      if (r.removed) {
        console.log(ansi.green('✓') + ` ${name} eliminada.`);
      } else {
        console.log(ansi.yellow('⚠') + ` ${r.reason}`);
      }
    });

  // -------------------------------------------------------------------------
  // storm import [path]
  //
  // Two modes:
  //   - Interactive (default): wizard with prompts. Requires a TTY.
  //   - Non-interactive: triggered by passing flags or running in a non-TTY
  //     environment (CI, agent subprocess). Driven entirely by flags.
  // -------------------------------------------------------------------------
  program
    .command('import [path]')
    .description('Importa un proyecto existente: analiza con LLM y agrega scaffolding storm.')
    .option('-y, --yes', 'Pisar archivos existentes sin preguntar (no interactivo).')
    .option('--mode <mode>', 'Profundidad del análisis: shallow | deep.')
    .option('--provider <id>', 'Provider para ANALIZAR: ollama-cloud | ollama-local | claude | via-claude-code | via-opencode.')
    .option('--model <name>', 'Modelo para --provider (e.g. kimi-k2.6:cloud).')
    .option('--agent <id>', 'Agent (CLI): claude-code | opencode | <custom>.')
    .option('--launch-provider <id>', 'Provider para ABRIR el proyecto. Default: --provider si puede lanzar el agent.')
    .option('--launch-model <name>', 'Modelo para --launch-provider.')
    .option('--name <name>', 'Nombre del proyecto.')
    .option('--description <text>', 'Descripción corta.')
    .option('--stack <id>', 'Override del stack detectado por el LLM.')
    .option('--db <id>', 'Override de la base de datos.')
    .option('--branch <path>', 'Sumar branch (repetible).', collect, [])
    .option('--skill <name>', 'Sumar skill custom (repetible).', collect, [])
    .option('--agent-name <name>', 'Sumar agent file custom (repetible).', collect, [])
    .option('--skip-llm', 'No llamar al LLM, usar solo defaults + flags.')
    .action(async (importPath, opts) => {
      // Flags-driven invocation forces non-interactive mode.
      const flagsPresent = opts.yes || opts.mode || opts.provider || opts.model ||
        opts.agent || opts.launchProvider || opts.launchModel ||
        opts.skipLlm || opts.name || opts.description || opts.stack || opts.db ||
        (opts.branch && opts.branch.length) ||
        (opts.skill && opts.skill.length) ||
        (opts.agentName && opts.agentName.length);

      // No TTY → can't run the wizard regardless of flags.
      const noTty = !process.stdin.isTTY || !process.stdout.isTTY;

      if (flagsPresent || noTty) {
        if (noTty && !opts.yes) {
          console.error(
            ansi.red('error:') +
            ' storm import necesita --yes en entornos no interactivos para confirmar overrides.\n' +
            'Sumá --yes y los flags que necesites (--provider, --mode, etc).',
          );
          process.exitCode = 1;
          return;
        }
        try {
          const { runImportNonInteractive } = await import('./commands/import.js');
          await runImportNonInteractive({
            cwd: importPath ? path.resolve(process.cwd(), importPath) : process.cwd(),
            mode: opts.mode,
            provider: opts.provider,
            model: opts.model ?? null,
            agent: opts.agent,
            launchProvider: opts.launchProvider,
            launchModel: opts.launchModel ?? null,
            name: opts.name,
            description: opts.description,
            stack: opts.stack,
            db: opts.db,
            extraBranches: opts.branch,
            skills: opts.skill,
            agentNames: opts.agentName,
            yes: !!opts.yes,
            skipLLM: !!opts.skipLlm,
            log: (msg) => console.log(msg),
          });
        } catch (err) {
          console.error(ansi.red('error:') + ' ' + (err.message ?? String(err)));
          process.exitCode = 1;
        }
        return;
      }

      // Default: interactive wizard.
      await runImportWizard({
        cwd: process.cwd(),
        providedPath: importPath,
      });
    });

  // -------------------------------------------------------------------------
  // storm templates
  // -------------------------------------------------------------------------
  const templates = program
    .command('templates')
    .description('List or inspect available project templates.');

  templates
    .command('list')
    .description('List templates from the registry.')
    .action(async () => {
      const { listTemplates } = await import('./commands/templates.js');
      const reg = await listTemplates();
      if (reg.length === 0) {
        console.log(ansi.dim('Todavía no hay templates en el registry.'));
        console.log(
          ansi.dim('Mirá ') +
            'https://github.com/Diegodelp/storm-ai/blob/main/templates/registry.json' +
            ansi.dim(' para más info.'),
        );
        return;
      }
      console.log('');
      for (const t of reg) {
        console.log(`  ${ansi.cyan(t.id.padEnd(24))} ${ansi.bold(t.label)}`);
        if (t.description) console.log(`  ${' '.repeat(24)} ${ansi.dim(t.description)}`);
        console.log(`  ${' '.repeat(24)} ${ansi.dim(t.repo)}`);
        console.log('');
      }
      console.log(ansi.dim('Usá:  storm new <name> --template <id>'));
    });

  templates
    .command('info <id>')
    .description('Show details of a specific template (clones to inspect metadata).')
    .action(async (id) => {
      const { getTemplate } = await import('./commands/templates.js');
      const entry = await getTemplate(id);
      if (!entry) {
        console.log(ansi.red('✗') + ` No existe el template "${id}".`);
        return;
      }
      console.log('');
      console.log(ansi.bold(entry.label));
      console.log(ansi.dim(entry.description));
      console.log('');
      console.log(`  id:       ${ansi.cyan(entry.id)}`);
      console.log(`  repo:     ${entry.repo}`);
      console.log(`  ref:      ${entry.ref ?? 'main'}`);
      if (entry.stackId) console.log(`  stack:    ${entry.stackId}`);
      if (entry.minStormVersion) {
        console.log(`  min storm version: ${entry.minStormVersion}`);
      }
      console.log('');
      console.log(ansi.dim('Para crear un proyecto:  storm new <name> --template ' + entry.id));
    });

  // -------------------------------------------------------------------------
  // storm config
  // -------------------------------------------------------------------------
  const cfgCmd = program
    .command('config')
    .description('Show or modify the global storm-ai defaults (for new projects and `storm import`).')
    .action(async () => {
      // No subcommand → run interactive wizard.
      const { runConfigWizard } = await import('./ui/wizard-config.js');
      await runConfigWizard({ cwd: process.cwd() });
    });

  cfgCmd
    .command('get [key]')
    .description('Print the value of a config key (or all keys if omitted).')
    .action(async (key) => {
      const { readAllConfig, getConfigValue, CONFIG_FILE_PATH } =
        await import('./commands/config.js');
      if (!key) {
        const cfg = await readAllConfig();
        console.log('');
        console.log(`  ${ansi.dim('file:')}            ${CONFIG_FILE_PATH}`);
        console.log(`  ${'provider:'.padEnd(17)}${cfg.defaultProvider?.provider ?? ansi.dim('(unset)')}`);
        console.log(`  ${'model:'.padEnd(17)}${cfg.defaultProvider?.model ?? ansi.dim('(unset)')}`);
        console.log(`  ${'agent:'.padEnd(17)}${cfg.defaultAgent ?? 'claude-code'}`);
        console.log(`  ${'launchCommand:'.padEnd(17)}${cfg.defaultLaunchCommand ?? ansi.dim('(unset; only used for custom agents)')}`);
        console.log(`  ${'ollamaHost:'.padEnd(17)}${cfg.ollamaHost ?? 'http://127.0.0.1:11434'}`);
        return;
      }
      try {
        const r = await getConfigValue(key);
        if (r.value == null) {
          console.log(ansi.dim('(no value)'));
        } else {
          console.log(r.value);
        }
      } catch (err) {
        console.error(ansi.red('error: ') + err.message);
        process.exitCode = 1;
      }
    });

  cfgCmd
    .command('set <key> <value>')
    .description('Set a config key. Keys: provider, model, agent, launchCommand, ollamaHost.')
    .action(async (key, value) => {
      const { setConfigValue } = await import('./commands/config.js');
      try {
        await setConfigValue(key, value);
        console.log(ansi.green('✓') + ` ${key} = ${ansi.cyan(value)}`);
        if (key === 'provider') {
          console.log(ansi.dim('  model reseteado si cambió el provider. Proyectos existentes: `storm project`.'));
        } else if (key === 'model' || key === 'agent') {
          console.log(ansi.dim('  Solo afecta proyectos nuevos. Para uno existente: `storm project set ' + key + ' ...`.'));
        }
      } catch (err) {
        console.error(ansi.red('error: ') + err.message);
        process.exitCode = 1;
      }
    });

  cfgCmd
    .command('unset <key>')
    .description('Clear a config key.')
    .action(async (key) => {
      const { setConfigValue } = await import('./commands/config.js');
      try {
        await setConfigValue(key, null);
        console.log(ansi.green('✓') + ` ${key} unset`);
      } catch (err) {
        console.error(ansi.red('error: ') + err.message);
        process.exitCode = 1;
      }
    });

  cfgCmd
    .command('path')
    .description('Print the absolute path of the global config file.')
    .action(async () => {
      const { CONFIG_FILE_PATH } = await import('./commands/config.js');
      console.log(CONFIG_FILE_PATH);
    });

  // -------------------------------------------------------------------------
  // storm project — per-project launch settings (provider/model/agent)
  // -------------------------------------------------------------------------
  const projCmd = program
    .command('project')
    .description('Show or change how THIS project is launched (agent, provider, model).')
    .action(async () => {
      const { requireProjectRoot } = await import('./core/paths.js');
      const { runProjectSettingsWizard } = await import('./ui/wizard-project.js');
      const root = await requireProjectRoot(process.cwd());
      await runProjectSettingsWizard({ projectRoot: root });
    });

  projCmd
    .command('get [key]')
    .description('Print provider, model, agent and launchCommand (or one of them).')
    .action(async (key) => {
      const { requireProjectRoot } = await import('./core/paths.js');
      const { getProjectSettings, validateProjectSettings, PROJECT_KEYS } = await import('./commands/project.js');
      const root = await requireProjectRoot(process.cwd());
      const s = await getProjectSettings(root);
      if (key) {
        if (!PROJECT_KEYS.includes(key)) {
          console.error(ansi.red('error: ') + `Clave desconocida: ${key}. Válidas: ${PROJECT_KEYS.join(', ')}.`);
          process.exitCode = 1;
          return;
        }
        console.log(s[key] ?? ansi.dim('(no value)'));
        return;
      }
      console.log('');
      console.log(`  ${ansi.dim('project:')}         ${root}`);
      for (const k of PROJECT_KEYS) {
        console.log(`  ${(k + ':').padEnd(17)}${s[k] ?? ansi.dim('(unset)')}`);
      }
      const problem = validateProjectSettings(s);
      if (problem) console.log('\n  ' + ansi.yellow('⚠ ' + problem));
    });

  const runProjectSet = async (key, value, extra = {}) => {
    const { requireProjectRoot } = await import('./core/paths.js');
    const { updateProjectSettings, PROJECT_KEYS } = await import('./commands/project.js');
    if (!PROJECT_KEYS.includes(key)) {
      throw new Error(`Clave desconocida: ${key}. Válidas: ${PROJECT_KEYS.join(', ')}.`);
    }
    const root = await requireProjectRoot(process.cwd());
    const r = await updateProjectSettings(root, { [key]: value, ...extra });
    for (const k of PROJECT_KEYS) {
      if (r.before[k] !== r.after[k]) {
        console.log(ansi.green('✓') + ` ${k}: ${r.before[k] ?? '(unset)'} → ${ansi.cyan(r.after[k] ?? '(unset)')}`);
      }
    }
    for (const n of r.notes) console.log(ansi.dim('  ' + n));
    if (r.scaffold?.createdFiles.length) {
      console.log(ansi.dim('  creados: ' + r.scaffold.createdFiles.join(', ')));
    }
  };

  projCmd
    .command('set <key> <value>')
    .description('Set provider, model, agent or launchCommand for this project.')
    .option('--model <name>', 'With `set provider`: the model for it (needed for ollama-*).')
    .action(async (key, value, opts) => {
      try {
        if (opts.model && key !== 'provider') {
          throw new Error('--model solo se usa con `storm project set provider <id> --model <name>`.');
        }
        await runProjectSet(key, value, opts.model ? { model: opts.model } : {});
      } catch (err) {
        console.error(ansi.red('error: ') + err.message);
        process.exitCode = 1;
      }
    });

  projCmd
    .command('unset <key>')
    .description('Clear model or launchCommand for this project.')
    .action(async (key) => {
      try {
        await runProjectSet(key, null);
      } catch (err) {
        console.error(ansi.red('error: ') + err.message);
        process.exitCode = 1;
      }
    });

  // -------------------------------------------------------------------------
  // storm install
  // -------------------------------------------------------------------------
  program
    .command('install')
    .description('Create a global `storm` shortcut on this machine.')
    .option('--force', 'Overwrite existing shortcut')
    .action(async (opts) => {
      const r = await installCmd({ force: !!opts.force });
      if (r.created.length) {
        console.log(ansi.green('✓') + ` installed on ${r.platform}:`);
        for (const c of r.created) console.log('  ' + ansi.dim(c));
      }
      for (const w of r.warnings) console.log(ansi.yellow('  ⚠ ' + w));
      if (r.nextSteps.length) {
        console.log('\n' + ansi.bold('Next steps:'));
        for (const s of r.nextSteps) console.log('  ' + s);
      }
    });

  // -------------------------------------------------------------------------

  // Surface async errors nicely.
  try {
    await program.parseAsync(argv);
  } catch (err) {
    console.error('\n' + ansi.red('✗') + ' ' + (err.message ?? String(err)));
    if (process.env.STORM_DEBUG) console.error(err.stack);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------------

function group(items, keyFn) {
  const m = new Map();
  for (const item of items) {
    const k = keyFn(item);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(item);
  }
  return m;
}

// If invoked directly (node src/cli.js), bootstrap.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv);
}
