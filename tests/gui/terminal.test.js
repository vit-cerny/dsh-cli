/**
 * End-to-end tests of the interactive terminal UI.
 *
 * These drive the real binary in a pseudo-terminal, so they assert the screen a
 * user sees rather than the line-mode path a pipe would take.
 *
 * The layout under test is the scrollback design: a startup banner, a status
 * line, a one-row toolbar, and an inline `❯` prompt. There is deliberately no
 * bordered input box any more, so the earlier box-geometry assertions were
 * replaced rather than stretched to fit.
 *
 * Skipped by default; run with `npm run test:gui`.
 *
 * @module tests/gui/terminal.test
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { displayWidth } from '../../src/ui/text.js';
import { guiSkipReason, launchCli } from '../helpers/pty-harness.js';

const skip = guiSkipReason();

/** Lines with visible content, for readable assertion messages. */
function visible(lines) {
  return lines.filter((row) => row.trim() !== '');
}

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
    harness.dispose();
  }
}

/** The status row, whichever row it landed on. */
function statusRow(lines) {
  return lines.find((row) => /idle|working|interrupted/.test(row)) ?? '';
}

test('startup paints the banner, toolbar, status line and prompt', { skip }, async () => {
  await withCli({}, async (cli) => {
    const lines = await cli.waitFor((rows) => rows.some((row) => row.includes('\u276f')), {
      label: 'the prompt',
    });
    const text = lines.join('\n');

    assert.match(text, /dsh-cli v\d/, 'the banner names the client and version');
    assert.match(text, /sessions/, 'the toolbar lists the session tab');
    assert.match(text, /plugins/, 'the toolbar lists the plugin tab');
    assert.match(text, /model/, 'the toolbar lists the model tab');
    assert.match(statusRow(lines), /idle|working/, 'the status line names the state');
    assert.ok(visible(lines).length >= 4, 'the first frame is more than a bare prompt');
  });
});

test('a slash command runs and its output reaches the screen', { skip }, async () => {
  await withCli({}, async (cli) => {
    await cli.waitFor((rows) => rows.some((row) => row.includes('\u276f')), { label: 'the prompt' });
    cli.type('/help');
    cli.enter();

    // Regression: a command used to write into the transcript sink and return
    // without a repaint, so its output existed in memory but never appeared.
    const lines = await cli.waitFor((rows) => rows.some((row) => row.includes('/sessions')), {
      timeoutMs: 20_000,
      label: '/help output',
    });
    assert.ok(lines.some((row) => row.includes('/quit')), 'the command list includes /quit');
    assert.match(statusRow(lines), /idle|working/, 'the status line survives command output');
  });
});

test('typed text appears once and Enter clears the prompt', { skip }, async () => {
  await withCli({}, async (cli) => {
    await cli.waitFor((rows) => rows.some((row) => row.includes('\u276f')), { label: 'the prompt' });

    cli.type('/mod');
    const typed = await cli.waitFor((rows) => rows.some((row) => row.includes('/mod')), {
      label: 'the typed text',
    });
    const promptRow = typed.find((row) => row.includes('/mod')) ?? '';
    assert.equal(
      (promptRow.match(/\u276f/g) ?? []).length,
      1,
      `the prompt glyph must appear once, not smear: ${JSON.stringify(promptRow)}`,
    );

    cli.enter();
    await cli.waitFor(
      (rows) => {
        const prompt = rows.filter((row) => row.includes('\u276f')).at(-1) ?? '';
        return prompt.replace(/.*\u276f/, '').trim() === '';
      },
      { label: 'the prompt to clear after Enter' },
    );
  });
});

test('Ctrl+J inserts a second prompt line instead of submitting', { skip }, async () => {
  await withCli({}, async (cli) => {
    await cli.waitFor((rows) => rows.some((row) => row.includes('\u276f')), { label: 'the prompt' });
    cli.type('one\ntwo');

    const lines = await cli.waitFor((rows) => rows.some((row) => row.includes('two')), {
      label: 'the second input line',
    });
    // Both lines stay on screen: the newline went into the prompt, not a turn.
    assert.ok(lines.some((row) => row.includes('one')), 'the first line is still visible');
    assert.ok(lines.some((row) => row.includes('\u276f')), 'the prompt is still there, so nothing was submitted');
  });
});

test('Ctrl+D quits and the process exits cleanly', { skip }, async () => {
  await withCli({}, async (cli) => {
    await cli.waitFor((rows) => rows.some((row) => row.includes('\u276f')), { label: 'the prompt' });

    cli.ctrl('d');
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !cli.exited()) {
      await new Promise((resolve) => { setTimeout(resolve, 100); });
    }
    assert.ok(cli.exited(), 'Ctrl+D must exit the process');
    assert.equal(cli.exitCode(), 0, 'a normal quit reports success');
  });
});

test('a narrow terminal keeps the state marker and never overflows', { skip }, async () => {
  await withCli({ cols: 40, rows: 12 }, async (cli) => {
    const lines = await cli.waitFor((rows) => rows.some((row) => row.includes('\u276f')), {
      label: 'the prompt at 40 columns',
    });
    assert.match(statusRow(lines), /idle|working|interrupted/, 'the narrow status line still names the state');
    for (const [index, row] of lines.entries()) {
      assert.ok(
        displayWidth(row) <= 40,
        `row ${index + 1} is ${displayWidth(row)} wide: ${JSON.stringify(row)}`,
      );
    }
  });
});

test('Tab opens a searchable picker over commands', { skip }, async () => {
  await withCli({}, async (cli) => {
    await cli.waitFor((rows) => rows.some((row) => row.includes('\u276f')), { label: 'the prompt' });
    cli.tab();

    const lines = await cli.waitFor(
      (rows) => rows.some((row) => row.includes('commands') && row.includes('models')),
      { timeoutMs: 20_000, label: 'the command picker' },
    );
    assert.ok(lines.some((row) => /\bhelp\b/.test(row)), 'the picker lists the help command');
    assert.ok(lines.some((row) => row.includes('/sessions') || /sessions/.test(row)), 'the picker lists sessions too');
  });
});