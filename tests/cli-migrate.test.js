import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  applyMigration,
  convertMcpServer,
  detectSources,
  formatMcpEntry,
  formatPlan,
  looksLikeLiteralSecret,
  parseJsonc,
  planMigration,
} from '../src/cli/migrate.js';
import { encodeWorkspaceDir } from '../src/cli/store.js';

/**
 * Build a throwaway home with an opencode layout plus a DSH home.
 *
 * @param {(roots: { home: string, config: string, data: string, dsh: string }) => void} [seed]
 *   Optional fixture writer.
 * @returns {{ root: string, home: string, config: string, data: string, dsh: string, env: object }}
 */
function fixture(seed) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-cli-migrate-'));
  const home = path.join(root, 'home');
  const config = path.join(home, '.config', 'opencode');
  const data = path.join(home, '.local', 'share', 'opencode');
  const dsh = path.join(root, 'dsh');
  mkdirSync(config, { recursive: true });
  mkdirSync(data, { recursive: true });
  mkdirSync(dsh, { recursive: true });
  if (seed !== undefined) seed({ home, config, data, dsh });
  return { root, home, config, data, dsh, env: {} };
}

/**
 * Write one skill bundle under a root.
 *
 * @param {string} skillsRoot Root directory.
 * @param {string} name Bundle name.
 * @param {string} [body] `SKILL.md` contents.
 * @returns {void}
 */
function writeSkill(skillsRoot, name, body = `---\nname: ${name}\n---\nbody\n`) {
  mkdirSync(path.join(skillsRoot, name), { recursive: true });
  writeFileSync(path.join(skillsRoot, name, 'SKILL.md'), body);
}

/**
 * Write an opencode config file.
 *
 * @param {string} configDir opencode config directory.
 * @param {object} value Config object.
 * @param {string} [name] File name.
 * @returns {void}
 */
function writeConfig(configDir, value, name = 'opencode.json') {
  writeFileSync(path.join(configDir, name), JSON.stringify(value, null, 2));
}

/**
 * Run a plan for the fixture's opencode source.
 *
 * @param {{ home: string, dsh: string, env: object }} roots Fixture roots.
 * @param {object} [options] Plan overrides.
 * @returns {import('../src/cli/migrate.js').Plan} Plan.
 */
function planFor(roots, options = {}) {
  const [source] = detectSources(roots.home, roots.env);
  assert.ok(source, 'fixture should be detected as an opencode source');
  return planMigration(source, { dshHome: roots.dsh, ...options });
}

test('detectSources reports opencode with paths and counts', () => {
  const roots = fixture(({ config }) => {
    writeSkill(path.join(config, 'skills'), 'alpha');
    writeSkill(path.join(config, 'skills'), 'beta');
    writeConfig(config, { mcp: { local: { type: 'local', command: ['node', 'a.js'] } } });
  });
  try {
    const rows = detectSources(roots.home, roots.env);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 'opencode');
    assert.deepEqual(rows[0].counts.skills, 2);
    assert.deepEqual(rows[0].counts.mcp, 1);
    assert.equal(rows[0].paths.skills, path.join(roots.config, 'skills'));
    assert.deepEqual(rows[0].skillList.map((skill) => skill.name), ['alpha', 'beta']);
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test('detectSources returns nothing when no harness is installed', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-cli-migrate-empty-'));
  try {
    assert.deepEqual(detectSources(root, {}), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('detectSources reads sessions and projects from an opencode database', async () => {
  let sqlite;
  try {
    sqlite = await import('node:sqlite');
  } catch {
    return; // Node without node:sqlite degrades to "sessions unavailable".
  }
  const roots = fixture(({ data }) => {
    const db = new sqlite.DatabaseSync(path.join(data, 'opencode.db'));
    db.exec(
      'create table session_v2 (id text primary key, directory text, time_updated integer);' +
        'create table project (id text primary key, worktree text);',
    );
    db.prepare('insert into session_v2 values (?, ?, ?)').run('ses_a', 'C:/work/demo', 2);
    db.prepare('insert into session_v2 values (?, ?, ?)').run('ses_b', 'C:/work/other', 1);
    db.prepare('insert into project values (?, ?)').run('p1', 'C:/work/demo');
    db.close();
  });
  try {
    const [source] = detectSources(roots.home, roots.env);
    assert.equal(source.counts.sessions, 2);
    assert.equal(source.counts.projects, 1);
    assert.deepEqual(source.sessionList.map((session) => session.id), ['ses_a', 'ses_b']);
    // A database row is not a copyable log, so the plan states that plainly.
    const plan = planMigration(source, { dshHome: roots.dsh });
    const sessions = plan.items.filter((item) => item.kind === 'session');
    assert.equal(sessions.length, 2);
    assert.ok(sessions.every((item) => item.action === 'skip'));
    assert.match(sessions[0].reason, /SQLite/);
    assert.ok(plan.items.some((item) => item.kind === 'project' && item.action === 'skip'));
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test('skill copy is skipped when the destination already exists', () => {
  const roots = fixture(({ config, dsh }) => {
    writeSkill(path.join(config, 'skills'), 'alpha', '---\nname: alpha\n---\nnew\n');
    writeSkill(path.join(dsh, 'skills'), 'alpha', '---\nname: alpha\n---\nold\n');
  });
  try {
    const plan = planFor(roots);
    const item = plan.items.find((entry) => entry.kind === 'skill' && entry.name === 'alpha');
    assert.equal(item.action, 'skip');
    assert.match(item.reason, /destination exists/);

    const report = applyMigration(plan, { apply: true });
    assert.equal(report.applied, 0);
    assert.equal(report.skipped, 1);
    // The existing skill is untouched: a migration never rewrites silently.
    assert.match(readFileSync(path.join(roots.dsh, 'skills', 'alpha', 'SKILL.md'), 'utf8'), /old/);
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test('skill copy honours force and copies the bundle', () => {
  const roots = fixture(({ config, dsh }) => {
    writeSkill(path.join(config, 'skills'), 'alpha', '---\nname: alpha\n---\nnew\n');
    writeSkill(path.join(dsh, 'skills'), 'alpha', '---\nname: alpha\n---\nold\n');
  });
  try {
    const plan = planFor(roots, { force: true });
    assert.equal(plan.items[0].action, 'copy');
    const report = applyMigration(plan, { apply: true, force: true });
    assert.equal(report.applied, 1);
    assert.match(readFileSync(path.join(roots.dsh, 'skills', 'alpha', 'SKILL.md'), 'utf8'), /new/);
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test('MCP command[] converts to a DSH stdio row with args split out', () => {
  const roots = fixture(({ config }) => {
    writeConfig(config, {
      mcp: {
        obsidian: {
          type: 'local',
          command: ['node', 'server.js', 'C:/vault'],
          enabled: true,
          timeout: 180000,
          environment: { TOKEN: '{env:OBSIDIAN_TOKEN}', LOG_LEVEL: 'debug' },
        },
      },
    });
  });
  try {
    const plan = planFor(roots);
    const item = plan.items.find((entry) => entry.kind === 'mcp');
    assert.equal(item.action, 'convert');
    assert.deepEqual(item.data, {
      serverName: 'obsidian',
      transport: 'stdio',
      command: 'node',
      args: ['server.js', 'C:/vault'],
      env: { TOKEN: { envVar: 'OBSIDIAN_TOKEN' }, LOG_LEVEL: 'debug' },
      toolCallTimeoutMs: 180000,
    });

    applyMigration(plan, { apply: true });
    const written = readFileSync(item.to, 'utf8');
    // A reference must stay a reference: the fragment names the variable.
    assert.match(written, /dsh-mcp-client/);
    assert.match(written, /transport: "stdio"/);
    assert.match(written, /command: "node"/);
    assert.match(written, /TOKEN: !!js process\.env\.OBSIDIAN_TOKEN/);
    assert.doesNotMatch(written, /OBSIDIAN_TOKEN: "/);
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test('MCP remote server converts to streamable-http with its url', () => {
  const converted = convertMcpServer('foreman', { type: 'remote', url: 'http://127.0.0.1:4310/mcp' });
  assert.equal(converted.action, 'convert');
  assert.equal(converted.row.transport, 'streamable-http');
  assert.equal(converted.row.url, 'http://127.0.0.1:4310/mcp');
  assert.equal(converted.row.command, undefined);
});

test('a literal secret is detected and skipped with a reason', () => {
  // Synthetic, structurally realistic JWT. Never paste a real credential here:
  // this file is committed, and a fixture is not worth leaking a live key.
  const token = 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmaXh0dXJlIn0.c2lnbmF0dXJlLXZhbHVl';
  assert.equal(looksLikeLiteralSecret(token), true);
  // Built by concatenation on purpose: a committed `sk-...` literal trips secret
  // scanners and GitHub push protection even when it is obviously a fixture.
  assert.equal(looksLikeLiteralSecret(['sk', 'abcdefghijklmnopqrstuvwxyz012345'].join('-')), true);
  assert.equal(looksLikeLiteralSecret('C:/Users/example/vault'), false);

  const roots = fixture(({ config }) => {
    writeConfig(config, {
      mcp: { treg: { type: 'remote', url: 'https://treg.to/mcp/', headers: { Authorization: token } } },
    });
  });
  try {
    const plan = planFor(roots);
    const item = plan.items.find((entry) => entry.kind === 'mcp');
    assert.equal(item.action, 'skip');
    assert.match(item.reason, /literal secret/);
    assert.match(item.reason, /credential reference/);

    const report = applyMigration(plan, { apply: true });
    assert.equal(report.applied, 0);
    // Nothing is written for a refused server, so the key cannot reach disk.
    assert.equal(existsSync(path.join(roots.dsh, 'migrate')), false);
    assert.doesNotMatch(JSON.stringify(report), /eyJhbGciOiJIUzI1NiJ9/);
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test('a session id collision is skipped and reported', () => {
  const sessionId = '3f2a1c4e-0000-4000-8000-000000000001';
  const cwd = path.join('C:', 'work', 'demo');
  const roots = fixture(({ data, dsh }) => {
    // A copyable DSH v4 log in the source data root.
    const sourceDir = path.join(data, 'sessions', 'ws', sessionId);
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(path.join(sourceDir, 'session.v4.jsonl.zstd'), Buffer.from('stub'));
    // The same id already present in the DSH store.
    mkdirSync(path.join(dsh, 'sessions', encodeWorkspaceDir('C:/work/demo'), sessionId), { recursive: true });
  });
  try {
    const [source] = detectSources(roots.home, roots.env);
    // The stub log has no readable header, so the inventory comes from the
    // database path; inject the row directly to keep the fixture self-contained.
    const plan = planMigration(
      {
        ...source,
        sessionList: [{ id: sessionId, cwd, file: path.join(roots.data, 'sessions', 'ws', sessionId, 'session.v4.jsonl.zstd') }],
      },
      { dshHome: roots.dsh },
    );
    const item = plan.items.find((entry) => entry.kind === 'session');
    assert.equal(item.action, 'skip');
    assert.match(item.reason, /already exists in the DSH store/);

    const report = applyMigration(plan, { apply: true, force: true });
    assert.equal(report.applied, 0);
    // Force may replace a config fragment, never a conversation.
    assert.equal(
      existsSync(path.join(roots.dsh, 'sessions', encodeWorkspaceDir('C:/work/demo'), sessionId, 'session.v4.jsonl.zstd')),
      false,
    );
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test('a new session log is copied, never moved', () => {
  const sessionId = '3f2a1c4e-0000-4000-8000-000000000002';
  const roots = fixture(({ data }) => {
    const sourceDir = path.join(data, 'sessions', 'ws', sessionId);
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(path.join(sourceDir, 'session.v4.jsonl.zstd'), Buffer.from('stub'));
  });
  try {
    const [source] = detectSources(roots.home, roots.env);
    const file = path.join(roots.data, 'sessions', 'ws', sessionId, 'session.v4.jsonl.zstd');
    const plan = planMigration(
      { ...source, sessionList: [{ id: sessionId, cwd: 'C:/work/demo', file }] },
      { dshHome: roots.dsh },
    );
    assert.equal(plan.items.find((entry) => entry.kind === 'session').action, 'copy');

    const report = applyMigration(plan, { apply: true });
    assert.equal(report.applied, 1);
    const target = path.join(roots.dsh, 'sessions', encodeWorkspaceDir('C:/work/demo'), sessionId, 'session.v4.jsonl.zstd');
    assert.equal(readFileSync(target, 'utf8'), 'stub');
    // The source still exists: an import never consumes the original store.
    assert.equal(existsSync(file), true);
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test('a dry run writes nothing to disk', () => {
  const roots = fixture(({ config, data }) => {
    writeSkill(path.join(config, 'skills'), 'alpha');
    writeConfig(config, { mcp: { local: { type: 'local', command: ['node', 'a.js'] } } });
    const sessionDir = path.join(data, 'sessions', 'ws', 'sess-1');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(path.join(sessionDir, 'session.v4.jsonl.zstd'), Buffer.from('stub'));
  });
  try {
    const [source] = detectSources(roots.home, roots.env);
    const file = path.join(roots.data, 'sessions', 'ws', 'sess-1', 'session.v4.jsonl.zstd');
    const plan = planMigration(
      { ...source, sessionList: [{ id: 'sess-1', cwd: 'C:/work/demo', file }] },
      { dshHome: roots.dsh },
    );
    assert.ok(plan.items.some((item) => item.action !== 'skip'));

    const report = applyMigration(plan);
    assert.equal(report.dryRun, true);
    assert.equal(report.applied, 0);
    assert.ok(report.planned > 0);
    // The DSH home is untouched: no skills, no fragments, no session dirs.
    assert.deepEqual(
      { skills: existsSync(path.join(roots.dsh, 'skills')), migrate: existsSync(path.join(roots.dsh, 'migrate')), sessions: existsSync(path.join(roots.dsh, 'sessions')) },
      { skills: false, migrate: false, sessions: false },
    );
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test('apply refuses a destination outside the DSH home', () => {
  const roots = fixture(() => {});
  try {
    const report = applyMigration(
      {
        source: 'opencode',
        dshHome: roots.dsh,
        items: [
          { kind: 'skill', name: 'escape', from: roots.config, to: path.join(roots.root, 'outside'), action: 'copy' },
        ],
        notes: [],
      },
      { apply: true },
    );
    assert.equal(report.failed, 1);
    assert.match(report.items[0].reason, /outside the DSH home/);
    assert.equal(existsSync(path.join(roots.root, 'outside')), false);
  } finally {
    rmSync(roots.root, { recursive: true, force: true });
  }
});

test('a disabled MCP server is skipped with a reason', () => {
  const converted = convertMcpServer('rea', { type: 'local', command: ['node', 'rea.mjs'], enabled: false });
  assert.equal(converted.action, 'skip');
  assert.match(converted.reason, /disabled/);
});

test('formatMcpEntry emits a loader row whose references stay references', () => {
  const lines = formatMcpEntry({
    serverName: 'obsidian',
    transport: 'stdio',
    command: 'node',
    args: ['server.js'],
    env: { TOKEN: { envVar: 'OBSIDIAN_TOKEN' } },
    toolCallTimeoutMs: 1000,
  });
  const text = lines.join('\n');
  assert.match(text, /^- id: mcp-obsidian$/m);
  assert.match(text, /^ {2}name: "@deepseek-ai\/dsh-mcp-client"$/m);
  assert.match(text, /^ {4}transport: "stdio"$/m);
  assert.match(text, /^ {6}- "server.js"$/m);
  assert.match(text, /^ {6}TOKEN: !!js process\.env\.OBSIDIAN_TOKEN$/m);
  assert.match(text, /^ {4}toolCallTimeoutMs: 1000$/m);
});

test('plan renders a plain table with action, kind, name and target', () => {
  const lines = formatPlan({
    source: 'opencode',
    dshHome: 'C:/dsh',
    notes: [],
    items: [
      { kind: 'skill', name: 'alpha', from: 'C:/a', to: 'C:/dsh/skills/alpha', action: 'copy' },
      { kind: 'mcp', name: 'treg', from: 'C:/b', to: 'C:/dsh/migrate/mcp/treg.yml', action: 'skip', reason: 'literal secret' },
    ],
  });
  assert.match(lines[0], /^action\s+kind\s+name\s+target\s+reason$/);
  assert.match(lines[1], /^copy\s+skill\s+alpha\s+C:\/dsh\/skills\/alpha$/);
  assert.match(lines[2], /literal secret/);
  // Plain text only: no emoji, no box drawing, no ANSI.
  for (const line of lines) assert.match(line, /^[\x20-\x7E]+$/);
});

test('parseJsonc accepts comments and trailing commas', () => {
  const parsed = parseJsonc(`{
    // a line comment
    "mcp": {
      "a": { "type": "local", "command": ["node"], },
    },
    /* block */
    "model": "x",
  }`);
  assert.deepEqual(parsed, { mcp: { a: { type: 'local', command: ['node'] } }, model: 'x' });
});