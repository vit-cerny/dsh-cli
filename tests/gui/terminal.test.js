/**
 * End-to-end tests of the interactive terminal UI.
 *
 * These drive the real binary in a pseudo-terminal, so they exercise the screen
 * a user sees rather than the line-mode code path a pipe would take. Each case
 * is a bug that shipped once and would ship again silently without this
 * coverage; the comments name the failure mode.
 *
 * They are skipped by default because every case launches the application and
 * its child runtime. Run them with `npm run test:gui`.
 *
 * @module tests/gui/terminal.test
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { frameProblems, guiSkipReason, launchCli } from '../helpers/pty-harness.js';

const skip = guiSkipReason();

/**
 * Launch, run one case, and always tear the child down.
 *
 * @param {object} options Harness options.
 * @param {(harness: object) => Promise<void>} body Test body.
 * @returns {Promise<void>}
 */
async function withCli(options, body) {
  const harness = launchCli(options);
  try {
    await body(harness);
  } finally {
    // Quit politely first so the child reaps itself and shuts its runtime down;
    // only a hung case falls through to the forced kill in `dispose`.
    await harness.quit();
    await harness.dispose();
  }
}

test('the TUI paints a closed input box, a prompt and a status bar', { skip }, async () => {
  await withCli({}, async (cli) => {
    // The box only exists in full-screen mode; a piped run would never draw it.
    const lines = await cli.waitFor(
      (rows) => rows.some((row) => row.includes('\u256d')) && rows.some((row) => row.includes('\u2570')),
      { label: 'the input box' },
    );

    assert.deepEqual(frameProblems(lines, { cols: 100 }), [], 'the first frame must be well formed');
    assert.ok(
      lines.some((row) => row.includes('\u276f')),
      'the prompt glyph must be visible',
    );
    // The status bar is pinned to the last row and always names the state.
    assert.match(lines.at(-1), /idle|working|interrupted/, 'the last row must be the status bar');
  });
});

test('a slash command runs and its output replaces the prompt', { skip }, async () => {
  await withCli({}, async (cli) => {
    await cli.waitFor((rows) => rows.some((row) => row.includes('\u256d')), { label: 'the input box' });
    cli.type('/help');
    cli.enter();

    // Regression: Enter used to be consumed as "accept the completion" while
    // the slash menu was open, so the command was re-inserted as text and never
    // ran. The list below only exists if the command actually executed.
    const lines = await cli.waitFor((rows) => rows.some((row) => row.includes('/sessions')), {
      label: '/help output',
    });
    assert.ok(lines.some((row) => row.includes('/quit')), 'the command list must list /quit');
    assert.match(lines.at(-1), /idle|working|interrupted/, 'the status bar must survive command output');
    assert.deepEqual(frameProblems(lines, { cols: 100 }), [], 'the frame must stay well formed after output');
  });
});

test('typed text appears in the box and Enter clears it', { skip }, async () => {
  await withCli({}, async (cli) => {
    await cli.waitFor((rows) => rows.some((row) => row.includes('\u256d')), { label: 'the input box' });

    cli.type('/mod');
    // Regression: the repaint used to erase from the caret column, so typing
    // produced "❯ /mo❯ /mod" — old characters under the new ones.
    const typed = await cli.waitFor((rows) => rows.some((row) => row.includes('/mod')), {
      label: 'the typed text',
    });
    const promptRow = typed.find((row) => row.includes('/mod')) ?? '';
    assert.equal(
      (promptRow.match(/\u276f/g) ?? []).length,
      1,
      `the prompt glyph must appear once, not smear: ${JSON.stringify(promptRow)}`,
    );

    // Enter clears the box: the submitted text moves into the transcript.
    cli.enter();
    const after = await cli.waitFor(
      (rows) => {
        const box = rows.findIndex((row) => row.includes('\u256d'));
        const bottom = rows.findIndex((row, index) => index > box && row.includes('\u2570'));
        if (box === -1 || bottom === -1) return false;
        const inside = rows.slice(box + 1, bottom).join(' ');
        return !inside.includes('/mod');
      },
      { label: 'the prompt box to clear after Enter' },
    );
    assert.deepEqual(frameProblems(after, { cols: 100 }), [], 'the frame must stay well formed after Enter');
  });
});

test('a multi-line prompt grows the box instead of overflowing it', { skip }, async () => {
  await withCli({}, async (cli) => {
    await cli.waitFor((rows) => rows.some((row) => row.includes('\u256d')), { label: 'the input box' });
    const before = cli.screen().findIndex((row) => row.includes('\u256d'));

    // Ctrl+J inserts a line break inside the prompt; Enter would submit.
    cli.type('one\ntwo\nthree');
    const lines = await cli.waitFor((rows) => rows.some((row) => row.includes('three')), {
      label: 'the third input line',
    });

    const after = lines.findIndex((row) => row.includes('\u256d'));
    assert.ok(after < before, 'the box must grow upwards as lines are added');
    assert.deepEqual(frameProblems(lines, { cols: 100 }), [], 'a grown box must still be a closed rectangle');
    assert.match(lines.at(-1), /idle|working|interrupted/, 'the status bar must stay on the last row');
  });
});

test('Ctrl+D quits and the process exits cleanly', { skip }, async () => {
  await withCli({}, async (cli) => {
    await cli.waitFor((rows) => rows.some((row) => row.includes('\u256d')), { label: 'the input box' });

    // Regression: teardown never released stdin, so Ctrl+D repainted and then
    // hung forever with the child still running.
    cli.ctrl('d');
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && !cli.exited()) {
      await new Promise((resolve) => { setTimeout(resolve, 100); });
    }
    assert.ok(cli.exited(), 'Ctrl+D must exit the process');
    assert.equal(cli.exitCode(), 0, 'a normal quit must report success');
  });
});

test('a narrow terminal keeps the state marker in the status bar', { skip }, async () => {
  await withCli({ cols: 40, rows: 12 }, async (cli) => {
    // Regression: the row was clipped from the right, which cut the state
    // marker first — a 40-column terminal never said whether the agent was busy.
    const lines = await cli.waitFor((rows) => rows.some((row) => row.includes('\u256d')), {
      label: 'the input box at 40 columns',
    });
    assert.match(lines.at(-1), /idle|working|interrupted/, `narrow status bar lost its state: ${lines.at(-1)}`);
    assert.deepEqual(frameProblems(lines, { cols: 40 }), [], 'a 40-column frame must stay well formed');
  });
});

test('Tab accepts the highlighted completion', { skip }, async () => {
  await withCli({}, async (cli) => {
    await cli.waitFor((rows) => rows.some((row) => row.includes('\u256d')), { label: 'the input box' });

    cli.type('/he');
    // The completion menu opens under the box as the user types.
    await cli.waitFor((rows) => rows.some((row) => row.includes('/help')), { label: 'the completion menu' });
    cli.tab();

    // Tab is the documented accept key; Enter must keep submitting instead.
    const lines = await cli.waitFor(
      (rows) => {
        const box = rows.findIndex((row) => row.includes('\u256d'));
        const bottom = rows.findIndex((row, index) => index > box && row.includes('\u2570'));
        if (box === -1 || bottom === -1) return false;
        return rows.slice(box + 1, bottom).join(' ').includes('/help');
      },
      { label: 'Tab to expand /he into /help' },
    );
    assert.deepEqual(frameProblems(lines, { cols: 100 }), [], 'the frame must stay well formed after completion');
  });
});

test('the header shows the tab row and Tab moves the highlight when no menu is open', { skip }, async () => {
  await withCli({}, async (cli) => {
    const start = await cli.waitFor((rows) => rows.some((row) => row.includes('sessions')), {
      label: 'the tab row',
    });
    // The active tab is wrapped in brackets; the rest are plain labels.
    assert.match(start[0], /\[sessions\]/, `the first tab must start active: ${start[0]}`);
    assert.ok(start[1].startsWith('\u2500'), 'a rule must separate the tabs from the transcript');

    // With no completion menu open, the first Tab focuses the toolbar and keeps
    // the current tab; the next Tab moves along it. Advancing on the focusing
    // press skipped a tab, so "Tab, Enter" never opened the tab shown as active.
    cli.tab();
    const focused = await cli.waitFor((rows) => rows[0]?.includes('[sessions]'), {
      label: 'the toolbar to take focus without changing tab',
    });
    assert.ok(focused[0].includes('project'), 'the tab row must still list every tab');
    cli.tab();
    const next = await cli.waitFor((rows) => /\[project\]/.test(rows[0] ?? ''), {
      label: 'the highlight to move to the second tab',
    });
    assert.ok(next[0].includes('sessions'), 'the tab row must still list every tab');
    assert.deepEqual(frameProblems(next, { cols: 100 }), [], 'moving the highlight must not disturb the frame');
  });
});
test('Enter on the active tab renders that command output', { skip }, async () => {
  await withCli({}, async (cli) => {
    await cli.waitFor((rows) => rows.some((row) => row.includes('[sessions]')), { label: 'the tab row' });

    // Regression: a slash command wrote to the transcript sink and returned
    // without a repaint, so its output existed in memory but never reached the
    // screen. The toolbar made it obvious: opening a tab looked like a no-op.
    // The first Tab focuses the toolbar (keeping sessions), so two more reach
    // the plugins tab.
    cli.tab();
    await cli.waitFor((rows) => rows[0]?.includes('[sessions]'), { label: 'toolbar focus' });
    cli.tab();
    await cli.waitFor((rows) => rows[0]?.includes('[project]'), { label: 'project tab' });
    cli.tab();
    await cli.waitFor((rows) => rows[0]?.includes('[plugins]'), { label: 'plugins tab' });
    cli.enter();

    const lines = await cli.waitFor(
      (rows) => rows.some((row) => row.includes('desktop') || row.includes('synced')),
      { timeoutMs: 20000, label: 'the plugin table' },
    );
    assert.ok(
      lines.some((row) => /^(synced|missing)/.test(row.trim())),
      'the plugin table must be visible on screen, not only in memory',
    );
    assert.deepEqual(frameProblems(lines, { cols: 100 }), [], 'the frame must stay well formed after the command');
  });
});
