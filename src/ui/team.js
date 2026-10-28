/**
 * Agent-team dashboard model and renderer.
 *
 * Reads the DSH agent-team files that already exist under `.agent-teams/`.
 * No session is spawned here: one terminal observes the team, and messages are
 * appended to the same inbox JSONL files the team agents already read.
 *
 * @module src/ui/team
 */

import { appendFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { padToWidth, truncateToWidth, wrapText } from './text.js';

const MAX_MESSAGES = 40;

/** Parse a JSONL file, ignoring malformed lines. */
export function readJsonLines(file, limit = MAX_MESSAGES) {
  if (!existsSync(file)) return [];
  try {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    const out = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* one bad line must not hide the rest */
      }
    }
    return limit > 0 ? out.slice(-limit) : out;
  } catch {
    return [];
  }
}

/** Locate the newest team, or a named one. */
export function findTeamDir(cwd, name) {
  const root = path.join(cwd, '.agent-teams');
  if (name) {
    const exact = path.join(root, name);
    return existsSync(path.join(exact, 'team.json')) ? exact : null;
  }
  if (!existsSync(root)) return null;
  let best = null;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(root, entry.name, 'team.json');
    if (!existsSync(file)) continue;
    const mtime = statSync(file).mtimeMs;
    if (best === null || mtime > best.mtime) best = { dir: path.join(root, entry.name), mtime };
  }
  return best?.dir ?? null;
}

/** Load the team graph, member inboxes and task summary. */
export function loadTeamState(cwd, name) {
  const dir = findTeamDir(cwd, name);
  if (dir === null) return null;
  let data;
  try {
    data = JSON.parse(readFileSync(path.join(dir, 'team.json'), 'utf8'));
  } catch {
    return null;
  }
  const members = (Array.isArray(data.members) ? data.members : []).map((member) => {
    const messages = readJsonLines(path.join(dir, 'inbox', `${member.name}.jsonl`));
    const visible = messages.filter((message) => message.from !== member.name);
    const last = visible[visible.length - 1];
    return {
      ...member,
      messages: visible,
      last,
      unread: visible.filter((message) => message.readAt === undefined).length,
      question:
        last !== undefined &&
        typeof last.content === 'string' &&
        last.content.includes('?') &&
        last.from !== 'captain' &&
        last.from !== 'manager',
    };
  });
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  const counts = {};
  for (const task of tasks) counts[task.status] = (counts[task.status] ?? 0) + 1;
  const captain =
    members.find((member) => member.name === 'captain') ??
    members.find((member) => /captain|manager|lead/i.test(member.name)) ??
    members[0] ??
    null;
  return {
    dir,
    name: data.name ?? path.basename(dir),
    description: data.description ?? '',
    phase: data.phase ?? '',
    captain,
    members,
    tasks,
    taskCounts: counts,
  };
}

/** Append one message to an agent inbox. */
export function sendInbox(teamDir, to, from, content) {
  const message = {
    id: randomUUID(),
    from,
    to,
    content: String(content ?? ''),
    ts: Date.now(),
    deliveredAt: Date.now(),
  };
  appendFileSync(path.join(teamDir, 'inbox', `${to}.jsonl`), `${JSON.stringify(message)}\n`, 'utf8');
  return message;
}

/** Render the manager -> workers -> shared-state graph. */
export function renderGraph(state, width = 100) {
  if (!state) return ['no .agent-teams/<name>/team.json found'];
  const lines = [];
  const captain = state.captain;
  lines.push('User prompt');
  lines.push('    |');
  lines.push(`    v`);
  lines.push(`Team lead: ${captain?.name ?? '(none)'} [${captain?.status ?? 'unknown'}]`);
  const workers = state.members.filter((member) => member !== captain && member.status !== 'removed');
  workers.forEach((member, index) => {
    const branch = index === workers.length - 1 ? '`--' : '|--';
    const badges = [
      `[${member.status ?? 'unknown'}]`,
      member.unread ? `${member.unread} unread` : '',
      member.question ? 'QUESTION' : '',
    ].filter(Boolean).join(' ');
    lines.push(`    ${branch} ${member.name} ${badges}`);
    const last = member.last?.content?.replace(/\s+/g, ' ').trim();
    if (last) lines.push(`    ${index === workers.length - 1 ? '   ' : '|  '} ${truncateToWidth(last, Math.max(20, width - 12))}`);
  });
  lines.push('    |');
  lines.push('    v');
  const done = state.taskCounts.completed ?? state.taskCounts.done ?? 0;
  lines.push(`Shared tasks & messages: ${state.tasks.length} tasks (${done} done)`);
  return lines;
}

/** Box one member. */
export function renderTile(member, selected, opened, width) {
  const inner = Math.max(20, width - 4);
  const border = '+' + '-'.repeat(inner) + '+';
  const title = `${opened ? '[open] ' : ''}${member.name} [${member.status ?? 'unknown'}]`;
  const rows = [border, `| ${padToWidth(truncateToWidth(title, inner - 2), inner - 2)} |`];
  const meta = [
    member.unread ? `${member.unread} unread` : '0 unread',
    member.question ? 'QUESTION' : '',
    `${member.messages.length} msgs`,
  ].filter(Boolean).join('  ');
  rows.push(`| ${padToWidth(truncateToWidth(meta, inner - 2), inner - 2)} |`);
  const last = member.last?.content?.replace(/\s+/g, ' ').trim() ?? '(no messages)';
  for (const line of wrapText(last, inner - 2).slice(0, 2)) {
    rows.push(`| ${padToWidth(line, inner - 2)} |`);
  }
  rows.push(border);
  return rows.map((line) => (selected ? `* ${line}` : `  ${line}`));
}

/** Render member tiles two-up when the terminal is wide enough. */
export function renderTiles(state, { width = 100, selected = 0, open = new Set() } = {}) {
  if (!state) return [];
  const members = state.members.filter((member) => member.status !== 'removed' || open.has(member.name));
  if (members.length === 0) return ['no active members'];
  const columns = width >= 100 ? 2 : 1;
  const tileWidth = Math.max(24, Math.floor(width / columns) - 2);
  const rows = [];
  for (let index = 0; index < members.length; index += columns) {
    const chunk = members.slice(index, index + columns);
    const blocks = chunk.map((member) =>
      renderTile(member, state.members.indexOf(member) === selected, open.has(member.name), tileWidth),
    );
    const height = Math.max(...blocks.map((block) => block.length));
    for (let line = 0; line < height; line += 1) {
      rows.push(blocks.map((block) => block[line] ?? ' '.repeat(tileWidth + 2)).join('  '));
    }
  }
  return rows;
}

/** Render the selected member's recent chat. */
export function renderChat(member, { width = 100, limit = 12 } = {}) {
  if (!member) return [];
  const lines = [`chat: ${member.name}`, ''];
  const messages = member.messages.slice(-limit);
  if (messages.length === 0) return lines.concat('(no messages)');
  for (const message of messages) {
    const head = `${message.from} -> ${message.to}`;
    lines.push(head);
    for (const line of wrapText(String(message.content ?? ''), Math.max(20, width - 2))) {
      lines.push(`  ${line}`);
    }
    lines.push('');
  }
  return lines;
}

/** Dashboard state: selection, open panes and view. */
export class TeamDashboard {
  constructor(state, { selected = 0, open = [], view = 'both' } = {}) {
    this.state = state;
    this.selected = selected;
    this.open = new Set(open);
    this.view = view;
    this.notifiedQuestions = new Set();
  }

  get members() {
    return this.state?.members ?? [];
  }

  get selectedMember() {
    return this.members[this.selected] ?? null;
  }

  setState(state) {
    this.state = state;
    if (this.selected >= this.members.length) this.selected = Math.max(0, this.members.length - 1);
  }

  move(delta) {
    if (this.members.length === 0) return;
    const active = this.members.filter((member) => member.status !== 'removed');
    const current = active.indexOf(this.selectedMember);
    const next = (current + delta + active.length) % active.length;
    this.selected = this.members.indexOf(active[next]);
  }

  toggleOpen() {
    const member = this.selectedMember;
    if (!member) return null;
    if (this.open.has(member.name)) this.open.delete(member.name);
    else this.open.add(member.name);
    return member.name;
  }

  close() {
    this.open.clear();
  }

  setView(view) {
    this.view = view;
  }

  /** Return questions that have not yet been routed to the captain. */
  takeQuestions() {
    const out = [];
    if (!this.state?.captain) return out;
    for (const member of this.members) {
      if (!member.question || member.last?.id === undefined) continue;
      if (this.notifiedQuestions.has(member.last.id)) continue;
      this.notifiedQuestions.add(member.last.id);
      out.push({ member, message: member.last });
    }
    return out;
  }

  render(width = 100) {
    if (!this.state) return ['no agent team found', '', 'start or open a DSH agent team, then press r'];
    const lines = [
      `${this.state.name}${this.state.phase ? `  [${this.state.phase}]` : ''}`,
      this.state.description ? truncateToWidth(this.state.description, width) : '',
      '',
    ];
    if (this.view !== 'tiles') lines.push(...renderGraph(this.state, width), '');
    if (this.view !== 'graph') {
      lines.push(...renderTiles(this.state, { width, selected: this.selected, open: this.open }));
      lines.push('');
    }
    if (this.open.size > 0) {
      for (const name of this.open) {
        const member = this.members.find((entry) => entry.name === name);
        lines.push(...renderChat(member, { width }));
      }
    }
    const counts = Object.entries(this.state.taskCounts ?? {})
      .map(([key, value]) => `${key}:${value}`)
      .join(' ');
    lines.push(`tasks ${counts || '0'}`);
    lines.push('keys: Tab/Left/Right select  Enter/o open-close  g graph  t tiles  s steer  c critic  n new worker  m manager  r refresh  q quit');
    return lines;
  }
}
