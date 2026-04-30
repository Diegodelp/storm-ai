/**
 * Wizard interactivo para `storm new`.
 *
 * Flujo: nombre → descripción → stack (lista) → base de datos (lista)
 *      → ramas iniciales → skills → agentes → provider → modelo
 *      → confirmar → createProject() → launchForProject().
 *
 * Las ramas iniciales vienen pre-cargadas según el stack elegido.
 * El usuario puede aceptarlas, modificarlas, o limpiar y escribir las
 * suyas.
 */

import * as clack from '@clack/prompts';

import { createProject } from '../commands/new.js';
import {
  detectOllama,
  listOllamaModels,
  pullOllamaModel,
  CLOUD_MODELS,
  LOCAL_RECOMMENDED,
} from '../core/providers.js';
import { STACKS, DATABASES, getStack, getDatabase } from '../core/stacks.js';
import * as ansi from './ansi.js';

export async function runNewWizard({ cwd }) {
  clack.intro(ansi.bold('Nuevo proyecto'));

  // Step 0: ¿desde template o desde cero?
  const startMode = await clack.select({
    message: '¿Cómo querés arrancar?',
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
    ],
    initialValue: 'template',
  });
  if (clack.isCancel(startMode)) return cancel();

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

  // ---- Provider + modelo ----
  const providerChoice = await clack.select({
    message: '¿Qué proveedor de IA?',
    options: [
      { value: 'ollama-cloud', label: 'Ollama (cloud)', hint: 'Gratis, calidad Claude. Recomendado.' },
      { value: 'ollama-local', label: 'Ollama (local)', hint: 'Corre en tu máquina.' },
      { value: 'claude',       label: 'Claude API',     hint: 'Requiere ANTHROPIC_API_KEY.' },
    ],
    initialValue: 'ollama-cloud',
  });
  if (clack.isCancel(providerChoice)) return cancel();

  let model = { provider: providerChoice, name: null };
  if (providerChoice === 'ollama-cloud') {
    model = await pickOllamaCloudModel();
    if (!model) return cancel();
  } else if (providerChoice === 'ollama-local') {
    model = await pickOllamaLocalModel();
    if (!model) return cancel();
  }

  // ---- Agent (CLI) ----
  const { AGENTS, getAgent } = await import('../core/agents.js');
  const { getDefaultAgent } = await import('../core/global-config.js');
  const defaultAgentId = await getDefaultAgent();

  const agentChoice = await clack.select({
    message: '¿Qué CLI vas a usar?',
    options: [
      ...AGENTS.map((a) => ({ value: a.id, label: a.label, hint: a.hint })),
      { value: '__custom__', label: 'Otro... (configurar después con `storm config`)' },
    ],
    initialValue: defaultAgentId,
  });
  if (clack.isCancel(agentChoice)) return cancel();

  const agentId = agentChoice === '__custom__' ? defaultAgentId : agentChoice;
  const agentLabel = agentChoice === '__custom__'
    ? 'custom (definí con `storm config`)'
    : (getAgent(agentId)?.label ?? agentId);

  // ---- Resumen + confirmación ----
  const summary = [
    `Nombre:       ${ansi.cyan(name)}`,
    description ? `Descripción:  ${description}` : null,
    stackLabel ? `Stack:        ${stackLabel}` : null,
    dbLabel ? `Base datos:   ${dbLabel}` : null,
    branches.length ? `Ramas:        ${branches.map((b) => b.path).join(', ')}` : null,
    (pickedSkills ?? []).length ? `Skills:       ${pickedSkills.join(', ')}` : null,
    agents.length ? `Agentes:      ${agents.map((a) => a.name).join(', ')}` : null,
    `Proveedor:    ${providerLabel(providerChoice)}${model.name ? ` (${model.name})` : ''}`,
    `CLI:          ${agentLabel}`,
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
      'Abriendo Claude Code...',
    'Listo',
  );

  const { launchForProject } = await import('../commands/launch.js');
  try {
    await launchForProject({ projectRoot: result.projectRoot });
  } catch (err) {
    clack.log.error(
      `No pude abrir Claude Code automáticamente: ${err.message}\n` +
        `Abrilo a mano:\n  cd "${result.projectRoot}"\n  claude`,
    );
  }
}

// ---------------------------------------------------------------------------
// Provider model pickers (sin cambios respecto de la versión previa)
// ---------------------------------------------------------------------------

async function pickOllamaCloudModel() {
  const options = [
    ...CLOUD_MODELS.map((m) => ({ value: m.name, label: m.label, hint: m.hint })),
    { value: '__other__', label: 'Otro...', hint: 'Escribir el nombre de cualquier modelo cloud' },
  ];

  const choice = await clack.select({
    message: 'Elegí un modelo cloud',
    options,
    initialValue: 'kimi-k2.6:cloud',
  });
  if (clack.isCancel(choice)) return null;

  if (choice === '__other__') {
    const custom = await clack.text({
      message: 'Nombre del modelo cloud (tiene que terminar en :cloud)',
      placeholder: 'mi-modelo:cloud',
      validate: (v) =>
        v?.trim().endsWith(':cloud')
          ? undefined
          : 'Los modelos cloud terminan en ":cloud".',
    });
    if (clack.isCancel(custom)) return null;
    return { provider: 'ollama-cloud', name: custom.trim() };
  }
  return { provider: 'ollama-cloud', name: choice };
}

async function pickOllamaLocalModel() {
  const ollama = await detectOllama();
  if (!ollama.installed) {
    clack.log.warn(
      'Ollama no está instalado. El proyecto se va a crear pero vas a ' +
        'tener que instalar Ollama antes de abrirlo.',
    );
  }

  const spinner = clack.spinner();
  spinner.start('Buscando modelos Ollama locales');
  const local = ollama.installed ? await listOllamaModels() : [];
  spinner.stop(`${local.length} modelo(s) local(es) detectado(s)`);

  const detectedNames = new Set(local.map((m) => m.name));
  const options = [];
  for (const m of local) {
    options.push({ value: m.name, label: m.name, hint: m.size ? `instalado · ${m.size}` : 'instalado' });
  }
  for (const m of LOCAL_RECOMMENDED) {
    if (!detectedNames.has(m.name)) {
      options.push({ value: m.name, label: m.label, hint: `${m.hint} · se descarga al elegirlo` });
    }
  }
  options.push({ value: '__other__', label: 'Otro...', hint: 'Escribir el nombre de cualquier modelo local' });

  const choice = await clack.select({ message: 'Elegí un modelo local', options });
  if (clack.isCancel(choice)) return null;

  let modelName;
  if (choice === '__other__') {
    const custom = await clack.text({
      message: 'Nombre del modelo local',
      placeholder: 'qwen3.5:9b',
      validate: (v) => (v?.trim() ? undefined : 'El nombre es obligatorio'),
    });
    if (clack.isCancel(custom)) return null;
    modelName = custom.trim();
  } else {
    modelName = choice;
  }

  if (ollama.installed && !detectedNames.has(modelName)) {
    const pullConfirm = await clack.confirm({
      message: `¿Descargar ${ansi.cyan(modelName)} ahora? (puede tardar varios minutos)`,
      initialValue: true,
    });
    if (clack.isCancel(pullConfirm)) return null;

    if (pullConfirm) {
      clack.log.info(`Descargando ${modelName}...`);
      const result = await pullOllamaModel(modelName);
      if (!result.ok) {
        clack.log.warn(`Falló la descarga: ${result.message}. Volvé a intentar: ollama pull ${modelName}`);
      } else {
        clack.log.success(`${modelName} listo.`);
      }
    }
  }
  return { provider: 'ollama-local', name: modelName };
}

function providerLabel(p) {
  if (p === 'ollama-cloud') return 'Ollama (cloud)';
  if (p === 'ollama-local') return 'Ollama (local)';
  if (p === 'claude') return 'Claude API';
  return p;
}

function cancel() {
  clack.cancel('Cancelado.');
}
