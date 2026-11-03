import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

// One JSONL file per conversation. Group, private and per-user scopes never share a file.
const SAFE_BYTE = /^[A-Za-z0-9_-]$/;
const PREFIX_MAX = 64;
const DIGEST_CHARS = 32;

// Conversation ids come from transports and may contain '/', ':', spaces, dots or lone
// surrogates. Encode one UTF-16 code unit at a time: safe ASCII stays as is, other ASCII
// becomes %XX, every non-ASCII code unit (Latin-1 included) becomes %uXXXX. That is
// injective over code units and lossless, so no id can inject a path separator or '..',
// and no two ids collapse.
function encodeId(raw) {
  let out = '';
  for (let index = 0; index < raw.length; index++) {
    const code = raw.charCodeAt(index);
    const char = String.fromCharCode(code);
    if (code < 0x80 && SAFE_BYTE.test(char)) out += char;
    else if (code < 0x80) out += '%' + code.toString(16).toUpperCase().padStart(2, '0');
    else out += '%u' + code.toString(16).toUpperCase().padStart(4, '0');
  }
  return out;
}

// The filename is "readable prefix ~ digest". Identity lives in the digest, never in the
// prefix: Windows and macOS compare filenames case-insensitively, so ids that differ only
// in letter case (g:A vs g:a) must still land on different files. The digest is taken over
// the encoded form, which is pure ASCII, so hashing cannot fold lone surrogates into U+FFFD
// the way Buffer.from(raw, 'utf8') does. '~' is not part of the encoded alphabet.
//
// The id contract is a string, nothing else: String(null ?? '') would merge null,
// undefined and '' into one conversation, so a non-string throws instead of guessing.
function safeId(id) {
  if (typeof id !== 'string') {
    throw new TypeError('conversation id must be a string, got ' + (id === null ? 'null' : typeof id));
  }
  const encoded = encodeId(id);
  const digest = createHash('sha256').update(encoded, 'ascii').digest('hex').slice(0, DIGEST_CHARS);
  return prefixOf(encoded) + '~' + digest;
}

// Whole escape units only, so the prefix never ends in a half written %XX or %uXXXX.
function prefixOf(encoded) {
  let prefix = '';
  for (let index = 0; index < encoded.length; ) {
    const width = encoded[index] === '%' ? (encoded[index + 1] === 'u' ? 6 : 3) : 1;
    if (prefix.length + width > PREFIX_MAX) break;
    prefix += encoded.slice(index, index + width);
    index += width;
  }
  return prefix || 'empty';
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
