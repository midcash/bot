import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// One JSONL file per conversation. Group, private and per-user scopes never share a file.
function safeId(id) {
  return String(id).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120) || 'unknown';
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
  async function recent(conversationId, limit) {
    const rows = await read(conversationId);
    return rows.slice(-limit);
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
