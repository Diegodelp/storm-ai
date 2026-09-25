/**
 * Wizard interactivo para `storm new`.
 *
 * Flujo: nombre → descripción → stack (lista) → base de datos (lista)
 *      → ramas iniciales → skills → agentes → CLI (agent) → provider → modelo
 *      → confirmar → createProject() → launchForProject().
 *
 * Las ramas iniciales vienen pre-cargadas según el stack elegido.
 * El usuario puede aceptarlas, modificarlas, o limpiar y escribir las
 * suyas.
 */

import * as clack from '@clack/prompts';

import { createProject } from '../commands/new.js';
import { getDefaultAgent, getDefaultProvider, getDefaultLaunchCommand } from '../core/global-config.js';
import { agentLabel } from '../core/agents.js';
import { pickLaunchSettings, providerLabel } from './pick-launch.js';
import { STACKS, DATABASES, getStack, getDatabase } from '../core/stacks.js';
import * as ansi from './ansi.js';

export async function runNewWizard({ cwd }) {
  clack.intro(ansi.bold('Nuevo proyecto'));
  clack.log.info(ansi.dim('Tip: presioná Esc en cualquier momento para volver al menú.'));

  // Step 0: ¿desde template o desde cero?
  const startMode = await clack.select({
    message: '¿Cómo querés arrancar? (Esc para volver al menú)',
    options: [
      {
        value: 'template',
        label: 'Desde un template',
        hint: 'Proyectos pre-armados (Next.js SaaS, etc) — listos para extender',
      },
      {
        value: 'scratch',
        label: 'Desde cero',
        hint: 'Wizard manual: vos definís stack, ramas, agentes',
      },
      { value: '__back__', label: '← Volver al menú principal' },
    ],
    initialValue: 'template',
  });
  if (clack.isCancel(startMode) || startMode === '__back__') return cancel();

  if (startMode === 'template') {
    const { runNewFromTemplateWizard } = await import('./wizard-new-template.js');
    const result = await runNewFromTemplateWizard({ cwd });
    if (result === 'done' || result === 'cancelled') return;
    // 'fallback' (registry vacío) cae al wizard from-scratch que sigue.
    clack.log.info('Continuando con el wizard desde cero.');
  }

  const name = await clack.text({
    message: 'Nombre del proyecto',
    placeholder: 'mi-proyecto',
    validate: (v) => (v?.trim() ? undefined : 'El nombre es obligatorio'),
  });
  if (clack.isCancel(name)) return cancel();

  const description = await clack.text({
    message: 'Descripción corta (opcional)',
    placeholder: 'CRM para inmobiliarias',
  });
  if (clack.isCancel(description)) return cancel();

  // ---- Stack picker ----
  const stackChoice = await clack.select({
    message: '¿Qué stack vas a usar?',
    options: STACKS.map((s) => ({
      value: s.id,
      label: s.label,
      hint: s.hint,
    })),
    initialValue: 'nextjs-app',
  });
  if (clack.isCancel(stackChoice)) return cancel();

  const stackPreset = getStack(stackChoice);
  let stackLabel = stackPreset?.label ?? '';

  if (stackChoice === 'other') {
    const custom = await clack.text({
      message: 'Describí tu stack',
      placeholder: 'Phoenix + LiveView + Postgres',
    });
    if (clack.isCancel(custom)) return cancel();
    stackLabel = custom?.trim() ?? '';
  }

  // ---- Database picker ----
  const dbChoice = await clack.select({
    message: 'Base de datos',
    options: DATABASES.map((d) => ({
      value: d.id,
      label: d.label,
      hint: d.hint,
    })),
    initialValue: 'postgres',
  });
  if (clack.isCancel(dbChoice)) return cancel();

  const dbPreset = getDatabase(dbChoice);
  let dbLabel = dbPreset?.label ?? '';

  if (dbChoice === 'other') {
    const customDb = await clack.text({
      message: 'Describí tu base de datos',
      placeholder: 'Cassandra cluster con 3 nodos',
    });
    if (clack.isCancel(customDb)) return cancel();
    dbLabel = customDb?.trim() ?? '';
  } else if (dbChoice === 'none') {
    dbLabel = '';
  }

  // ---- Initial branches (pre-loaded from stack) ----
  const defaultBranches = stackPreset?.initialBranches ?? [];
  const branchesPlaceholder = defaultBranches.length
    ? defaultBranches.join(', ')
    : 'src/auth, src/ui, src/api';

  const branchesRaw = await clack.text({
    message: 'Ramas iniciales (separadas por coma)',
    placeholder: branchesPlaceholder,
    initialValue: defaultBranches.join(', '),
  });
  if (clack.isCancel(branchesRaw)) return cancel();

  const branches = (branchesRaw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => ({ path: p, description: '' }));

  // ---- Skills ----
  const pickedSkills = await clack.multiselect({
    message: 'Skills integradas (espacio para marcar)',
    options: [
      { value: 'plan-systematic', label: 'plan-systematic', hint: 'Separa pedidos en tareas por rama' },
      { value: 'compact-route',   label: 'compact-route',   hint: 'Decide qué ramas cargar' },
      { value: 'refresh-compact', label: 'refresh-compact', hint: 'Regenera .context-compact/ a demanda' },
    ],
    initialValues: ['plan-systematic', 'compact-route', 'refresh-compact'],
    required: false,
  });
  if (clack.isCancel(pickedSkills)) return cancel();

  // ---- Agents ----
  const agents = [];
  const wantAgents = await clack.confirm({
    message: '¿Agregar agentes ahora?',
    initialValue: false,
  });
  if (clack.isCancel(wantAgents)) return cancel();

  if (wantAgents) {
    let addMore = true;
    while (addMore) {
      const agentName = await clack.text({
        message: 'Nombre del agente',
        placeholder: 'Frontend Dev',
        validate: (v) => (v?.trim() ? undefined : 'El nombre es obligatorio'),
      });
      if (clack.isCancel(agentName)) return cancel();

      const slash = await clack.text({
        message: 'Comando slash',
        placeholder: 'frontend-dev',
        validate: (v) => (v?.trim() ? undefined : 'El slash es obligatorio'),
      });
      if (clack.isCancel(slash)) return cancel();

      const agentDesc = await clack.text({
        message: 'Descripción del agente (opcional)',
      });
      if (clack.isCancel(agentDesc)) return cancel();

      agents.push({ name: agentName, slash, description: agentDesc || '' });

      const another = await clack.confirm({
        message: '¿Agregar otro agente?',
        initialValue: false,
      });
      if (clack.isCancel(another)) return cancel();
      addMore = another;
    }
  }

  // ---- Agent (CLI) → provider → modelo ----
  // Arrancamos desde los defaults globales (`storm config`).
  const defProvider = await getDefaultProvider();
  const launchPick = await pickLaunchSettings({
    agent: await getDefaultAgent(),
    launchCommand: await getDefaultLaunchCommand(),
    provider: defProvider?.provider ?? 'ollama-cloud',
    model: defProvider?.model ?? null,
  });
  if (!launchPick) return cancel();
  const { agent: agentId, model } = launchPick;

  // ---- Resumen + confirmación ----
  const summary = [
    `Nombre:       ${ansi.cyan(name)}`,
    description ? `Descripción:  ${description}` : null,
    stackLabel ? `Stack:        ${stackLabel}` : null,
    dbLabel ? `Base datos:   ${dbLabel}` : null,
    branches.length ? `Ramas:        ${branches.map((b) => b.path).join(', ')}` : null,
    (pickedSkills ?? []).length ? `Skills:       ${pickedSkills.join(', ')}` : null,
    agents.length ? `Agentes:      ${agents.map((a) => a.name).join(', ')}` : null,
    `CLI:          ${agentLabel(agentId)}`,
    `Proveedor:    ${providerLabel(model.provider)}${model.name ? ` (${model.name})` : ''}`,
    launchPick.launchCommand ? `Comando:      ${launchPick.launchCommand}` : null,
    `Carpeta base: ${ansi.dim(cwd)}`,
  ].filter(Boolean).join('\n');
  clack.note(summary, 'Se va a crear');

  const confirm = await clack.confirm({
    message: '¿Crear el proyecto con esta configuración?',
    initialValue: true,
  });
  if (clack.isCancel(confirm) || !confirm) return cancel();

  // ---- Create ----
  const spinner = clack.spinner();
  spinner.start('Creando proyecto');
  let result;
  try {
    result = await createProject({
      name,
      description: description || '',
      stack: stackLabel || '',
      stackId: stackChoice,
      database: dbLabel || '',
      databaseId: dbChoice,
      parentDir: cwd,
      branches,
      skills: (pickedSkills ?? []).map((s) => ({ name: s })),
      agents,
      model,
      agent: agentId,
      launch: launchPick.launchCommand ? { customCommand: launchPick.launchCommand } : {},
    });
    spinner.stop('Proyecto creado');
  } catch (err) {
    spinner.stop(ansi.red('Falló'));
    clack.log.error(err.message ?? String(err));
    return;
  }

  for (const w of result.warnings) clack.log.warn(w);

  clack.note(
    `${ansi.bold(result.safeName)} listo en\n  ${ansi.dim(result.projectRoot)}\n\n` +
      `Abriendo ${agentLabel(agentId)}...`,
    'Listo',
  );

  const { launchForProject } = await import('../commands/launch.js');
  try {
    await launchForProject({ projectRoot: result.projectRoot });
  } catch (err) {
    clack.log.error(
      `No pude abrir ${agentLabel(agentId)} automáticamente: ${err.message}\n` +
        `Abrilo después con:  storm open "${result.projectRoot}"`,
    );
  }
}

function cancel() {
  clack.cancel('Cancelado.');
}
