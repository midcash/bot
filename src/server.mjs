import { createServer as createHttpServer } from 'node:http';

const PERSONA = [
  '你是 midbot，一个在群里工作的助手。',
  '回答用中文，像跟同事说话：先给判断，再给依据，不要罗列字段。',
  '不确定就说不确定，不要编数字或链接。',
].join('\n');

export function normalizeEvent(payload) {
  if (!payload || payload.post_type !== 'message') {
    return { error: 'unsupported post_type' };
  }
  const text = String(payload.raw_message ?? payload.message ?? '').trim();
  if (!text) return { error: 'empty message' };

  if (payload.message_type === 'group') {
    const groupId = String(payload.group_id ?? '');
    if (!groupId) return { error: 'missing group_id' };
    return {
      scope: 'group',
      chatId: groupId,
      userId: String(payload.user_id ?? 'unknown'),
      conversationId: 'g:' + groupId,
      text,
    };
  }

  if (payload.message_type === 'private') {
    const userId = String(payload.user_id ?? '');
    if (!userId) return { error: 'missing user_id' };
    return {
      scope: 'private',
      chatId: userId,
      userId,
      conversationId: 'u:' + userId,
      text,
    };
  }

  return { error: 'unsupported message_type' };
}

function buildPrompt(turns, text) {
  const lines = [PERSONA, ''];
  if (turns.length > 0) {
    lines.push('最近的对话：');
    for (const turn of turns) {
      lines.push((turn.role === 'user' ? '用户：' : '你：') + turn.text);
    }
    lines.push('');
  }
  lines.push('用户：' + text);
  return lines.join('\n');
}

export function createServer({ config, brain, memory, policy, logger = console }) {
  return createHttpServer(async (req, res) => {
    try {
      await handle(req, res);
    } catch (error) {
      logger.error('unhandled: ' + ((error && error.stack) || error));
      if (!res.headersSent) {
        const body = JSON.stringify({ ok: false, error: 'internal' });
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(body);
      } else {
        res.end();
      }
    }
  });

  async function handle(req, res) {
    const send = (status, body) => {
      const text = JSON.stringify(body);
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(text),
      });
      res.end(text);
    };

    if (req.method === 'GET' && req.url === '/healthz') {
      return send(200, { ok: true, model: config.model });
    }

    if (req.method !== 'POST' || req.url !== '/v1/message') {
      return send(404, { ok: false, error: 'not found' });
    }

    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 64 * 1024) return send(413, { ok: false, error: 'payload too large' });
    }

    let payload;
    try {
      payload = JSON.parse(raw || '{}');
    } catch {
      return send(400, { ok: false, error: 'invalid json' });
    }

    const event = normalizeEvent(payload);
    if (event.error) return send(400, { ok: false, error: event.error });

    if (!policy.allowed(event.chatId)) {
      logger.warn('denied chat ' + event.chatId);
      return send(403, { ok: false, reason: 'chat not allowed' });
    }
    if (policy.rateLimited(event.chatId)) {
      return send(429, { ok: false, reason: 'rate limited' });
    }

    const turns = await memory.recent(event.conversationId, config.recentTurns);
    const prompt = buildPrompt(turns, event.text);

    await memory.append(event.conversationId, { role: 'user', text: event.text, meta: { userId: event.userId } });

    const result = await brain.ask({
      sessionId: 'midbot-' + event.conversationId.replace(/[^A-Za-z0-9_.-]/g, '-'),
      prompt,
    });

    if (!result.ok) {
      logger.error('brain failed: ' + result.error);
      return send(502, { ok: false, reason: 'brain failed', detail: result.error });
    }

    const filtered = policy.filter(result.text);
    const folded = policy.fold(filtered);
    const clipped = folded.text.slice(0, config.maxReplyChars);

    await memory.append(event.conversationId, {
      role: 'assistant',
      text: clipped,
      meta: { folded: folded.folded, ms: result.ms },
    });

    return send(200, {
      ok: true,
      conversationId: event.conversationId,
      reply: clipped,
      folded: folded.folded,
      omitted: folded.omitted,
      ms: result.ms,
      usage: result.usage,
    });
  }
}
