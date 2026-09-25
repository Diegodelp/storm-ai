import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { runMenuAction, waitForMenu } from '../src/ui/menu-action.js';
import { runOpenWizard } from '../src/ui/wizard-open.js';
import { stripAnsi } from '../src/ui/ansi.js';

function terminal(t) {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = output.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (value) => { input.isRaw = value; };
  let text = '';
  output.on('data', (chunk) => { text += chunk; });
  t.after(() => { input.destroy(); output.destroy(); });
  return { input, output, text: () => text };
}

function wizardFixture(overrides = {}) {
  const messages = [];
  const project = { name: 'mi-proyecto', root: '/projects/mi proyecto' };
  const log = (message) => messages.push(stripAnsi(message));
  let launched = 0;
  const ui = {
    intro: log, note: log, cancel: log,
    log: { info: log, error: log, warn: log },
    spinner: () => ({ start: log, stop: log }),
    select: async () => project.root,
    isCancel: (value) => typeof value === 'symbol',
  };
  return {
    messages, project, launched: () => launched,
    deps: {
      ui,
      discoverProjects: async () => [project],
      loadConfig: async () => ({ agent: 'opencode', model: { provider: 'via-opencode', name: null } }),
      launchProject: async ({ projectRoot }) => {
        assert.equal(projectRoot, project.root);
        launched++;
      },
      ...overrides,
    },
  };
}

test('opening failure remains visible until Enter, instead of disappearing after 250 ms', async (t) => {
  const io = terminal(t);
  const fixture = wizardFixture({
    launchProject: async () => { throw new Error('opencode terminó con código 7: modelo no disponible'); },
  });
  let finished = false;
  const action = runMenuAction(() => runOpenWizard({}, fixture.deps), {
    reportError: (message) => io.output.write(message),
    pause: () => waitForMenu(io),
  }).then((result) => { finished = true; return result; });
  await delay(350);
  assert.equal(finished, false);
  assert.match(io.text(), /No pude abrir el proyecto "mi-proyecto"/);
  assert.match(io.text(), /código 7: modelo no disponible/);
  assert.match(io.text(), /cd "\/projects\/mi proyecto"/);
  assert.match(io.text(), /storm launch/);
  assert.match(io.text(), /Presioná Enter/);
  assert.ok(!io.text().includes('\x1bc'), 'must not clear the error');
  io.input.write('\r');
  assert.equal(await action, true);
  assert.equal(io.input.isRaw, false);
});

test('selector shows the configured CLI/provider and reports a normal exit', async () => {
  const fixture = wizardFixture();
  assert.equal(await runOpenWizard({}, fixture.deps), 'done');
  assert.equal(fixture.launched(), 1);
  const output = fixture.messages.join('\n');
  assert.match(output, /CLI: OpenCode/);
  assert.match(output, /Provider: via-opencode/);
  assert.match(output, /OpenCode finalizó/);
  assert.doesNotMatch(output, /Abriendo Claude Code/);
});

test('configuration errors include the project and prevent launch', async () => {
  const fixture = wizardFixture({ loadConfig: async () => { throw new Error('project.config.json inválido'); } });
  await assert.rejects(runOpenWizard({}, fixture.deps), (err) => {
    assert.match(err.message, /mi-proyecto/);
    assert.match(err.message, /project.config.json inválido/);
    assert.match(err.message, /storm launch/);
    assert.equal(err.cause.message, 'project.config.json inválido');
    return true;
  });
  assert.equal(fixture.launched(), 0);
});

test('discovery errors stop the spinner and reach the menu error handler', async () => {
  const fixture = wizardFixture({ discoverProjects: async () => { throw new Error('sin acceso a la carpeta'); } });
  const events = [];
  await runMenuAction(() => runOpenWizard({}, fixture.deps), {
    reportError: (message) => events.push(message),
    pause: async () => { events.push('acknowledge'); return true; },
  });
  assert.ok(fixture.messages.includes('Falló la búsqueda de proyectos'));
  assert.deepEqual(events, ['sin acceso a la carpeta', 'acknowledge']);
});

test('cancelling project selection returns directly without launching or pausing', async () => {
  const fixture = wizardFixture();
  fixture.deps.ui.select = async () => Symbol('cancel');
  const result = await runMenuAction(() => runOpenWizard({}, fixture.deps), {
    pause: async () => { assert.fail('cancel must return directly to menu'); },
  });
  assert.equal(result, true);
  assert.equal(fixture.launched(), 0);
});

test('an empty project list stays visible until acknowledged', async () => {
  const fixture = wizardFixture({ discoverProjects: async () => [] });
  let paused = false;
  await runMenuAction(() => runOpenWizard({}, fixture.deps), {
    pause: async () => { paused = true; return true; },
  });
  assert.equal(paused, true);
  assert.match(fixture.messages.join('\n'), /No se encontraron proyectos/);
  assert.equal(fixture.launched(), 0);
});

test('Ctrl+C and EOF at the acknowledgement exit instead of redrawing the menu', async (t) => {
  for (const end of [(input) => input.write('\x03'), (input) => input.end()]) {
    const io = terminal(t);
    const waiting = waitForMenu(io);
    end(io.input);
    assert.equal(await waiting, false);
    assert.equal(io.input.isRaw, false);
    assert.equal(io.input.listenerCount('keypress'), 0);
  }
});

test('non-TTY acknowledgement never blocks or starts a new menu loop', async (t) => {
  const io = terminal(t);
  io.input.isTTY = false;
  assert.equal(await waitForMenu(io), false);
  assert.equal(io.text(), '');
});

test('errors represented as strings are still shown before acknowledgement', async () => {
  const errors = [];
  await runMenuAction(async () => { throw 'provider no disponible'; }, {
    reportError: (message) => errors.push(message), pause: async () => true,
  });
  assert.deepEqual(errors, ['provider no disponible']);
});
