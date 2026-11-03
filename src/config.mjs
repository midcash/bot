import { join } from 'node:path';

function num(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function list(value) {
  return (value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

// Every knob has a safe default so the server starts with no environment at all.
export function loadConfig(env = process.env, cwd = process.cwd()) {
  return {
    host: env.MIDBOT_HOST || '127.0.0.1',
    port: num(env.MIDBOT_PORT, 8787),

    // brain
    model: env.MIDBOT_MODEL || 'magpie/workbuddy-ai/deepseek-v4.1-flash-sg',
    thinking: env.MIDBOT_THINKING || 'low',
    piEntry: env.MIDBOT_PI_ENTRY || '',
    piBin: env.MIDBOT_PI_BIN || 'pi',
    brainTimeoutMs: num(env.MIDBOT_BRAIN_TIMEOUT_MS, 120000),
    sandboxDir: env.MIDBOT_SANDBOX || join(cwd, '.midbot', 'sandbox'),
    sessionDir: env.MIDBOT_SESSION_DIR || join(cwd, '.midbot', 'sessions'),

    // memory
    memoryDir: env.MIDBOT_MEMORY_DIR || join(cwd, '.midbot', 'memory'),
    recentTurns: num(env.MIDBOT_RECENT_TURNS, 6),

    // policy
    allowedChats: list(env.MIDBOT_ALLOWED_CHATS),
    allowAll: env.MIDBOT_ALLOW_ALL !== '0',
    rate: {
      windowMs: num(env.MIDBOT_RATE_WINDOW_MS, 60000),
      max: num(env.MIDBOT_RATE_MAX, 12),
    },
    foldThreshold: num(env.MIDBOT_FOLD_THRESHOLD, 800),
    maxReplyChars: num(env.MIDBOT_MAX_REPLY_CHARS, 2000),
  };
}
