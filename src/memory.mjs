import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// One JSONL file per conversation. Group, private and per-user scopes never share a file.
function safeId(id) {
  return String(id).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120) || 'unknown';
}

// recent() takes a number, a numeric string (the config comes from the environment) or
// nothing at all. Only a positive finite number keeps rows; a missing, negative, NaN or
// non-numeric limit collapses to 0. Fail closed: a bad limit can never widen the prompt.
function normalizeLimit(limit) {
  const value = Number(limit);
  if (!Number.isFinite(value)) return 0;
  const whole = Math.trunc(value);
  return whole > 0 ? whole : 0;
}

export function createMemory(dir) {
  async function pathFor(conversationId) {
    await mkdir(dir, { recursive: true });
    return join(dir, safeId(conversationId) + '.jsonl');
  }

  async function append(conversationId, turn) {
    const file = await pathFor(conversationId);
    const row = {
      at: new Date().toISOString(),
      role: turn.role,
      text: String(turn.text ?? ''),
      meta: turn.meta ?? {},
    };
    await appendFile(file, JSON.stringify(row) + '\n', 'utf8');
    return row;
  }

  async function read(conversationId) {
    const file = await pathFor(conversationId);
    let raw = '';
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  // Newest N turns, oldest first, ready to paste into a prompt.
  // A limit of 0 (MIDBOT_RECENT_TURNS=0) means "inject nothing", and so does a
  // missing limit: only a positive number returns rows.
  async function recent(conversationId, limit) {
    const take = normalizeLimit(limit);
    if (take === 0) return [];
    const rows = await read(conversationId);
    return rows.slice(-take);
  }

  async function search(conversationId, query, limit = 10) {
    const needle = String(query || '').toLowerCase();
    if (!needle) return [];
    const rows = await read(conversationId);
    return rows
      .filter((row) => row.text.toLowerCase().includes(needle))
      .slice(-limit);
  }

  return { append, read, recent, search };
}
