// Admission and output policy. Everything here is deterministic: no model calls.

const PATH_RULES = [
  /[A-Za-z]:\\[^\s'"<>|]+/g, // C:\Users\...
  /(?:^|\s)\/(?:Users|home|root|etc|var|opt|srv|tmp)\/[^\s'"<>|]+/g, // /home/x
];

const SECRET_RULES = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*[^\s,;]+/gi,
  /\b[A-Za-z0-9+/_-]{40,}={0,2}\b/g, // long opaque tokens
];

const REPLACEMENTS = [
  [/\bC:\\Users\\[^\\\s]+/gi, 'C:\\Users\\<redacted>'],
  [/\/(?:home|Users)\/[^\s/]+/g, '/<redacted>'],
];

export function createPolicy(config, now = () => Date.now()) {
  const hits = new Map();

  function allowed(chatId) {
    if (config.allowedChats.length === 0) return config.allowAll;
    return config.allowedChats.includes(String(chatId));
  }

  function rateLimited(chatId) {
    const key = String(chatId);
    const stamp = now();
    const window = config.rate.windowMs;
    const recent = (hits.get(key) || []).filter((at) => stamp - at < window);
    if (recent.length >= config.rate.max) {
      hits.set(key, recent);
      return true;
    }
    recent.push(stamp);
    hits.set(key, recent);
    return false;
  }

  // Redact paths and secrets before anything leaves the process.
  function filter(text) {
    let out = String(text ?? '');
    for (const [pattern, replacement] of REPLACEMENTS) out = out.replace(pattern, replacement);
    for (const pattern of PATH_RULES) out = out.replace(pattern, '<path>');
    for (const pattern of SECRET_RULES) out = out.replace(pattern, '<redacted>');
    return out;
  }

  // Long answers become a card-sized summary; the caller can send the full text
  // through a forward-message adapter later.
  function fold(text) {
    const full = String(text ?? '');
    if (full.length <= config.foldThreshold) {
      return { folded: false, text: full, omitted: 0 };
    }
    const head = full.slice(0, config.foldThreshold);
    const cut = Math.max(head.lastIndexOf('\n'), head.lastIndexOf('。'));
    const kept = cut > config.foldThreshold * 0.6 ? head.slice(0, cut + 1) : head;
    return {
      folded: true,
      text: kept + '\n\n（全文 ' + full.length + ' 字，已折叠）',
      omitted: full.length - kept.length,
    };
  }

  return { allowed, rateLimited, filter, fold };
}
