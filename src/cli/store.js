/**
 * Read-only view of the DSH session store, for `dsh-cli sessions` and `resume`.
 *
 * The store is owned by the runtime, not by this client, and its layout is an
 * implementation detail. Measured layout on this machine (DSH 0.2.1-rc.2):
 *
 *   ~/.dsh/sessions/<encoded-cwd>/<sessionId>/session.v4.jsonl.zstd
 *
 * The file is a zstd stream of JSON lines whose first record is a header
 * `{ type: "session", id, createdAt, cwd, ... }`. Segments are appended as the
 * session grows, so the file is **not** one continuous stream; only the header
 * (the first frame) is read here, and everything after it is ignored.
 *
 * Consequences, stated honestly:
 * - this module never writes; a corrupt or future-format file yields `null`;
 * - it is a *listing* aid. `session/resume` on the runtime remains the source
 *   of truth, so `resume` accepts an id the listing does not know;
 * - if DSH changes the layout, `sessions` prints "no persisted sessions found"
 *   and `resume <id>` still works — the CLI degrades, it does not fork trivia.
 *
 * @module src/cli/store
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { normalizeEvent } from '../session/events.js';

/** File name of the session log inside a session directory. */
const SESSION_FILE = 'session.v4.jsonl.zstd';

/** Only the header record is ever needed; the first frame is far smaller. */
const HEADER_BYTES = 64 * 1024;

/** Resume renders a bounded recent window, never the whole persisted log. */
const HISTORY_LIMIT = 40;
const HISTORY_BYTES = 8 * 1024 * 1024;
const HISTORY_DECOMPRESSED_BYTES = 32 * 1024 * 1024;
const HISTORY_FRAME_BYTES = 16 * 1024 * 1024;
const ZSTD_MAGIC = 0xfd2fb528;

/**
 * @typedef {object} SessionSummary
 * @property {string} id Session id (the id the runtime accepts on `session/resume`).
 * @property {string} [cwd] Working directory recorded in the header.
 * @property {number} [createdAt] Creation time (epoch ms).
 * @property {number} [updatedAt] File mtime (epoch ms), a proxy for "last activity".
 * @property {string} title Display label.
 * @property {string} dir Absolute session directory.
 */

/**
 * Decode the header record of one session log.
 *
 * @param {string} file Absolute path to `session.v4.jsonl.zstd`.
 * @returns {{ id?: string, cwd?: string, createdAt?: number } | null} The header, when readable.
 */
export function readSessionHeader(file) {
  try {
    const buffer = readFileSync(file);
    let text;
    if (buffer.byteLength > HEADER_BYTES) {
      // A long log has several appended frames; only the first holds the
      // header, so try the bounded head before paying for the whole file.
      try {
        text = zstdDecompressSync(buffer.subarray(0, HEADER_BYTES)).toString('utf8');
      } catch {
        text = zstdDecompressSync(buffer).toString('utf8');
      }
    } else {
      text = zstdDecompressSync(buffer).toString('utf8');
    }
    const firstLine = text.split('\n', 1)[0];
    const record = JSON.parse(firstLine);
    if (record === null || typeof record !== 'object') return null;
    return {
      ...(typeof record.id === 'string' ? { id: record.id } : {}),
      ...(typeof record.cwd === 'string' ? { cwd: record.cwd } : {}),
      ...(Number.isFinite(record.createdAt) ? { createdAt: record.createdAt } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Decode every complete frame in a session log to text.
 *
 * Exported because other readers (usage accounting) need the same log without
 * a second zstd frame walker; the ceilings here bound all of them.
 *
 * @param {Buffer} buffer Compressed log.
 * @returns {string | null} Decoded text, or null when no frame decoded.
 */
export function decodeSessionLog(buffer) {
  const texts = decodeZstdFrames(buffer);
  if (texts.length === 0) return null;
  return texts.join('');
}

/**
 * Decode complete Zstandard frames, ignoring an incomplete trailing frame.
 *
 * DSH appends a new frame per batch, so `zstdDecompressSync(wholeFile)` only
 * returns the first frame. Frame layout follows the public Zstandard format;
 * no private Node or DSH APIs are used.
 *
 * @param {Buffer} buffer Compressed log.
 * @returns {string[]} Decoded frame texts.
 */
function decodeZstdFrames(buffer) {
  /** @type {string[]} */
  const texts = [];
  let offset = 0;
  let decompressedBytes = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 5 || buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break;
    const descriptor = buffer[start + 4];
    if ((descriptor & 24) !== 0) break;
    offset += 5;
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) break;
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return texts;
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      if (blockType === 3) return texts;
      const blockSize = blockHeader >>> 3;
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return texts;
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) offset += 4;
    if (offset > buffer.length || offset - start > HISTORY_FRAME_BYTES) break;
    const text = zstdDecompressSync(buffer.subarray(start, offset)).toString('utf8');
    decompressedBytes += Buffer.byteLength(text);
    texts.push(text);
    if (decompressedBytes > HISTORY_DECOMPRESSED_BYTES) break;
  }
  return texts;
}

/**
 * Read recent user/assistant messages from a persisted session.
 *
 * @param {string} file Session log path.
 * @param {{ limit?: number }} [options] Maximum messages, newest last.
 * @returns {{ role: 'user' | 'assistant', text: string }[]} Renderable history.
 */
export function readSessionHistory(file, { limit = HISTORY_LIMIT } = {}) {
  try {
    const stat = statSync(file);
    if (stat.size > HISTORY_BYTES) return [];
    /** @type {{ role: 'user' | 'assistant', text: string }[]} */
    const messages = [];
    for (const text of decodeZstdFrames(readFileSync(file))) {
      for (const line of text.split(/\r?\n/)) {
        if (line === '') continue;
        /** @type {any} */
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        if (record?.type !== 'user/message' && record?.type !== 'assistant/message') continue;
        for (const event of normalizeEvent(record, { sessionId: record.sessionId })) {
          if (event.kind === 'user' && event.source?.kind === 'user') {
            const content = String(event.text ?? '').trim();
            if (content !== '') messages.push({ role: 'user', text: content });
          } else if (event.kind === 'assistant-text') {
            const content = String(event.text ?? '').trim();
            if (content === '') continue;
            const last = messages.at(-1);
            if (last?.role === 'assistant') last.text += content;
            else messages.push({ role: 'assistant', text: content });
          }
        }
      }
    }
    return messages.slice(-Math.max(1, limit));
  } catch {
    return [];
  }
}

/**
 * Locate one persisted session log without scanning unrelated workspaces.
 *
 * @param {SessionSummary[]} summaries Local listing (a bounded index).
 * @param {string} sessionId Full session id after prefix resolution.
 * @returns {string | null} Log path, or null when the index does not know it.
 */
export function findSessionFile(summaries, sessionId) {
  const dir = summaries.find((row) => row.id === sessionId)?.dir;
  return dir === undefined ? null : path.join(dir, SESSION_FILE);
}

/**
 * List persisted sessions, newest activity first.
 *
 * @param {string} dshHome DSH home directory.
 * @param {{ limit?: number, includeAll?: boolean }} [options] `limit` caps the
 *   result; `includeAll` returns sessions from every working directory rather
 *   than the current one.
 * @returns {SessionSummary[]} Summaries, newest first.
 */
export function readSessionSummaries(dshHome, options = {}) {
  const limit = Number.isSafeInteger(options.limit) && options.limit > 0 ? options.limit : 20;
  const root = path.join(dshHome, 'sessions');
  /** @type {SessionSummary[]} */
  const rows = [];

  /** @type {string[]} */
  let workspaceDirs;
  try {
    workspaceDirs = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name));
  } catch {
    return rows;
  }

  for (const workspaceDir of workspaceDirs) {
    /** @type {import('node:fs').Dirent[]} */
    let sessionDirs;
    try {
      sessionDirs = readdirSync(workspaceDir, { withFileTypes: true }).filter((entry) =>
        entry.isDirectory(),
      );
    } catch {
      continue;
    }
    for (const entry of sessionDirs) {
      const dir = path.join(workspaceDir, entry.name);
      const file = path.join(dir, SESSION_FILE);
      /** @type {import('node:fs').Stats} */
      let stat;
      try {
        stat = statSync(file);
      } catch {
        continue; // no readable log: not a resumable session
      }
      const header = readSessionHeader(file);
      const id =
        header?.id ?? (typeof entry.name === 'string' && entry.name !== '' ? entry.name : undefined);
      if (id === undefined) continue;
      rows.push({
        id,
        ...(header?.cwd === undefined ? {} : { cwd: header.cwd }),
        ...(header?.createdAt === undefined ? {} : { createdAt: header.createdAt }),
        updatedAt: stat.mtimeMs,
        title: `${entry.name}`,
        dir,
      });
    }
  }

  rows.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return rows.slice(0, limit);
}

/**
 * The encoded directory name DSH uses for a working directory.
 *
 * `C:\Users\example\dsh-cli` → `--C-Users-example-dsh-cli--` (backslashes become
 * dashes, a drive colon becomes a dash, wrapped in the same separator). Used
 * only to put the current project's sessions first; a mismatch is harmless
 * because the listing falls back to every workspace.
 *
 * @param {string} cwd Absolute working directory.
 * @returns {string} Encoded directory name.
 */
export function encodeWorkspaceDir(cwd) {
  const normalized = String(cwd).replace(/[\\/]+$/, '');
  return `--${normalized.replace(/[:\\/]/g, '-')}--`;
}

/**
 * Format a row for a terminal listing.
 *
 * @param {SessionSummary} row Summary.
 * @param {number} now Current epoch ms.
 * @returns {string} One line, without styling.
 */
export function formatSessionRow(row, now = Date.now()) {
  const age = row.updatedAt === undefined ? '?' : formatAge(now - row.updatedAt);
  const cwd = row.cwd === undefined ? '?' : row.cwd;
  return `${row.id.padEnd(44)}  ${age.padStart(6)}  ${cwd}`;
}

/**
 * Compact duration: `42s`, `13m`, `5h`, `3d`.
 *
 * @param {number} ms Milliseconds.
 * @returns {string} Label.
 */
export function formatAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
