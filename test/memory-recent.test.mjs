import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemory } from '../src/memory.mjs';
import { createPolicy } from '../src/policy.mjs';
import { createServer } from '../src/server.mjs';
import { loadConfig } from '../src/config.mjs';

// Every test gets its own temp dir: nothing is written inside the repository.
async function withMemory(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'midbot-memory-recent-'));
  try {
    return await fn(createMemory(dir), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function seed(memory, id, count) {
  for (let index = 1; index <= count; index++) {
    await memory.append(id, { role: 'user', text: 'turn-' + index });
  }
}

async function texts(memory, id, limit) {
  return (await memory.recent(id, limit)).map((row) => row.text);
}

test('recent(chat, 0) returns no history (issue #6 reproduction)', async () => {
  await withMemory(async (memory) => {
    await seed(memory, 'chat', 3);

    assert.deepEqual(await texts(memory, 'chat', 0), []);
  });
});

test('negative, NaN and non-numeric limits return no history', async () => {
  await withMemory(async (memory) => {
    await seed(memory, 'chat', 3);

    assert.deepEqual(await texts(memory, 'chat', -1), []);
    assert.deepEqual(await texts(memory, 'chat', -99), []);
    assert.deepEqual(await texts(memory, 'chat', NaN), []);
    assert.deepEqual(await texts(memory, 'chat', 'nope'), []);
    assert.deepEqual(await texts(memory, 'chat', null), []);
  });
});

test('limit semantics are locked: positive caps the tail, numeric strings are accepted', async () => {
  await withMemory(async (memory) => {
    await seed(memory, 'chat', 5);

    assert.deepEqual(await texts(memory, 'chat', 2), ['turn-4', 'turn-5']);
    assert.deepEqual(await texts(memory, 'chat', '2'), ['turn-4', 'turn-5']);
    assert.deepEqual(await texts(memory, 'chat', 10), ['turn-1', 'turn-2', 'turn-3', 'turn-4', 'turn-5']);
    assert.deepEqual(await texts(memory, 'chat', 2.9), ['turn-4', 'turn-5']);
  });
});

test('a missing limit is fail-closed: recent(chat) returns no history', async () => {
  await withMemory(async (memory) => {
    await seed(memory, 'chat', 4);

    assert.deepEqual(await texts(memory, 'chat'), []);
    assert.deepEqual(await texts(memory, 'chat', undefined), []);
    assert.deepEqual(await texts(memory, 'chat', null), []);
  });
});

test('an empty conversation is empty for every limit', async () => {
  await withMemory(async (memory) => {
    assert.deepEqual(await texts(memory, 'nobody', 0), []);
    assert.deepEqual(await texts(memory, 'nobody', 6), []);
    assert.deepEqual(await texts(memory, 'nobody'), []);
  });
});

test('MIDBOT_RECENT_TURNS=0 reaches the server as 0, not as a fallback', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'midbot-config-recent-'));
  try {
    const config = loadConfig({ MIDBOT_RECENT_TURNS: '0' }, dir);
    assert.equal(config.recentTurns, 0);

    const missing = loadConfig({}, dir);
    assert.equal(missing.recentTurns, 6);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Starts a real HTTP server on an ephemeral port and returns the prompts the brain saw.
async function withServer(recentTurns, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'midbot-server-recent-'));
  const config = loadConfig({ MIDBOT_RECENT_TURNS: String(recentTurns) }, dir);
  const memory = createMemory(config.memoryDir);
  const policy = createPolicy(config);
  const prompts = [];
  const brain = {
    async ask({ prompt }) {
      prompts.push(prompt);
      return { ok: true, text: 'ok', ms: 1, usage: null };
    },
  };
  const quiet = { error() {}, warn() {} };
  const server = createServer({ config, brain, memory, policy, logger: quiet });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;

  const post = (text) =>
    fetch(base + '/v1/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        post_type: 'message',
        message_type: 'group',
        group_id: 'fixture-group',
        user_id: '7',
        raw_message: text,
      }),
    });

  try {
    return await fn({ post, prompts, memory, config });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
}

test('MIDBOT_RECENT_TURNS=0 sends no history into the prompt of a real request', async () => {
  await withServer(0, async ({ post, prompts }) => {
    const first = await post('first message');
    assert.equal(first.status, 200);
    assert.equal((await first.json()).ok, true);

    const second = await post('second message');
    assert.equal(second.status, 200);

    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /second message/);
    assert.equal(prompts[1].includes('first message'), false, 'history leaked into the prompt');
    assert.equal(prompts[1].includes('最近的对话'), false, 'history block was injected');
  });
});

test('control: the same server with a positive limit does inject history', async () => {
  await withServer(6, async ({ post, prompts }) => {
    await post('first message');
    const second = await post('second message');
    assert.equal(second.status, 200);

    assert.match(prompts[1], /最近的对话/);
    assert.match(prompts[1], /first message/);
  });
});
