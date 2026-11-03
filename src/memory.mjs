import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// One JSONL file per conversation. Group, private and per-user scopes never share a file.
function safeId(id) {
  return String(id).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120) || 'unknown';
}

// recent() takes a number or a plain decimal string, and nothing else. Only a positive
// finite value keeps rows; everything else collapses to 0. Nothing goes through Number()
// blindly: Number(true) is 1, Number([2]) is 2 and Number(Symbol()) throws.
function normalizeLimit(limit) {
  if (typeof limit === 'number') {
    if (!Number.isFinite(limit)) return 0;
    const whole = Math.trunc(limit);
    return whole > 0 ? whole : 0;
  }
  if (typeof limit === 'string' && /^[0-9]+$/.test(limit)) {
    const whole = Number(limit);
    return Number.isFinite(whole) && whole > 0 ? whole : 0;
  }
  return 0;
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
