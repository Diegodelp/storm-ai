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
import * as ansi from './ui/ansi.js';

const VERSION = '0.1.0';

export async function runCli(argv) {
  // No args → interactive menu. This is the entry point for most users.
  if (argv.length <= 2) {
    return runInteractiveMenu({ cwd: process.cwd() });
  }

  const program = new Command();
  program
    .name('storm')
    .description('Context-aware project scaffolding for AI coding agents.')
    .version(VERSION)
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
    .option('--force', 'Overwrite if the directory exists')
    .action(async (name, opts) => {
      if (!name) {
        // Name omitted → prompt the user with the full wizard.
        await runNewWizard({ cwd: process.cwd() });
        return;
      }
      const result = await createProject({
        name,
        parentDir: process.cwd(),
        description: opts.description,
        stack: opts.stack,
        database: opts.db,
        force: !!opts.force,
      });
      console.log(ansi.green('✓') + ' Created project ' + ansi.bold(result.safeName));
      console.log('  ' + ansi.dim(result.projectRoot));
      if (result.warnings.length) {
        for (const w of result.warnings) console.log(ansi.yellow('  ⚠ ' + w));
      }
      console.log('\nNext: ' + ansi.cyan(`cd ${result.safeName}`) + ' and run ' + ansi.cyan('claude'));
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
    .description('Regenerate the .context-compact/ directory.')
    .action(async () => {
      const r = await refreshCmd({ cwd: process.cwd() });
      console.log(
        ansi.green('✓') +
          ` refreshed ${r.branchesWritten} branch(es), ${r.filesScanned} file(s)`,
      );
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
    .description('Open an existing project. Without target, list projects.')
    .action(async (target) => {
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
          '\n' + ansi.dim('Usage: storm open <name>  (launches Claude Code in that project)'),
        );
        return;
      }
      const root = await resolveTarget({ cwd: process.cwd(), target });
      console.log(ansi.green('✓') + ` ${ansi.cyan(root)}`);
      console.log(ansi.dim('  Run `claude` in that directory to start a session.'));
    });

  // -------------------------------------------------------------------------
  // storm launch
  // -------------------------------------------------------------------------
  program
    .command('launch')
    .description('Launch Claude Code using the configured provider/model.')
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
