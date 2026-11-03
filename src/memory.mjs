import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

// One JSONL file per conversation. Group, private and per-user scopes never share a file.
const SAFE_BYTE = /^[A-Za-z0-9_-]$/;
const MAX_NAME = 120;

// Conversation ids come from transports and may contain '/', ':', spaces or dots.
// Every byte outside [A-Za-z0-9_-] becomes %XX, so the mapping is injective and
// reversible: different ids always get different files, and no id can inject a path
// separator or '..'. '~' never appears in an encoded id; it is reserved for the empty
// id and as the separator before a digest.
function safeId(id) {
  const raw = String(id ?? '');
  let encoded = '';
  for (const byte of Buffer.from(raw, 'utf8')) {
    const char = String.fromCharCode(byte);
    encoded += byte < 0x80 && SAFE_BYTE.test(char)
      ? char
      : '%' + byte.toString(16).toUpperCase().padStart(2, '0');
  }
  if (encoded === '') return '~';
  if (encoded.length <= MAX_NAME) return encoded;
  // Overlong ids keep a readable prefix plus a digest of the full id. Because '~' is
  // not part of the encoded alphabet, a hashed name can never equal a plain one.
  const digest = createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 16);
  return encoded.slice(0, MAX_NAME - 17) + '~' + digest;
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
