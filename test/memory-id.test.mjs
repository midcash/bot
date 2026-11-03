import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemory } from '../src/memory.mjs';
import { createPolicy } from '../src/policy.mjs';
import { createServer } from '../src/server.mjs';
import { loadConfig } from '../src/config.mjs';

// Every test gets its own temp dir: nothing is written inside the repository.
async function withMemory(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'midbot-memory-id-'));
  try {
    return await fn(createMemory(dir), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function texts(memory, id) {
  return (await memory.read(id)).map((row) => row.text);
}

test('chat/a and chat:a do not share history (issue #5 reproduction)', async () => {
  await withMemory(async (memory) => {
    await memory.append('chat/a', { role: 'user', text: 'only-a' });

    assert.deepEqual(await texts(memory, 'chat:a'), []);
    assert.deepEqual(await texts(memory, 'chat/a'), ['only-a']);
  });
});

test('reverse direction: writing chat:a is invisible to chat/a', async () => {
  await withMemory(async (memory) => {
    await memory.append('chat:a', { role: 'user', text: 'only-colon' });

    assert.deepEqual(await texts(memory, 'chat/a'), []);
    assert.deepEqual(await texts(memory, 'chat:a'), ['only-colon']);
  });
});

test('five lookalike ids are pairwise isolated', async () => {
  const ids = ['chat:a', 'chat/a', 'chat.a', 'chat a', 'chat_a'];

  await withMemory(async (memory) => {
    for (const [index, id] of ids.entries()) {
      await memory.append(id, { role: 'user', text: 'turn-' + index });
    }

    for (const [index, id] of ids.entries()) {
      assert.deepEqual(await texts(memory, id), ['turn-' + index], 'id ' + id);
      for (const other of ids) {
        if (other === id) continue;
        const rows = await memory.read(other);
        assert.equal(
          rows.some((row) => row.text === 'turn-' + index),
          false,
          id + ' leaked into ' + other,
        );
      }
    }
  });
});

test('percent sign in an id is escaped, not passed through', async () => {
  await withMemory(async (memory) => {
    await memory.append('chat/a', { role: 'user', text: 'slash' });
    await memory.append('chat%2Fa', { role: 'user', text: 'literal-percent' });

    assert.deepEqual(await texts(memory, 'chat/a'), ['slash']);
    assert.deepEqual(await texts(memory, 'chat%2Fa'), ['literal-percent']);
  });
});

test('empty id does not collide with a literal placeholder id', async () => {
  await withMemory(async (memory) => {
    await memory.append('', { role: 'user', text: 'empty' });
    await memory.append('unknown', { role: 'user', text: 'literal-unknown' });
    await memory.append('~', { role: 'user', text: 'tilde' });

    assert.deepEqual(await texts(memory, ''), ['empty']);
    assert.deepEqual(await texts(memory, 'unknown'), ['literal-unknown']);
    assert.deepEqual(await texts(memory, '~'), ['tilde']);
  });
});

test('long ids stay distinct and keep a readable prefix', async () => {
  const base = 'g:' + '9'.repeat(300);
  const a = base + 'A';
  const b = base + 'B';

  await withMemory(async (memory, dir) => {
    await memory.append(a, { role: 'user', text: 'long-a' });
    await memory.append(b, { role: 'user', text: 'long-b' });

    assert.deepEqual(await texts(memory, a), ['long-a']);
    assert.deepEqual(await texts(memory, b), ['long-b']);

    const files = await readdir(dir);
    assert.equal(files.length, 2, 'long ids must not share a file');
    for (const file of files) {
      assert.ok(file.startsWith('g'), 'filename should keep a readable prefix: ' + file);
    }
  });
});

test('generated filenames are safe and recognisable', async () => {
  const ids = ['chat:a', 'chat/a', 'chat.a', 'chat a', 'chat_a', 'g:123', 'u:456'];

  await withMemory(async (memory, dir) => {
    for (const id of ids) {
      await memory.append(id, { role: 'user', text: 'x' });
    }

    const files = await readdir(dir);
    assert.equal(files.length, ids.length);

    for (const file of files) {
      assert.equal(file.includes('/'), false, 'path separator in ' + file);
      assert.equal(file.includes('\\'), false, 'path separator in ' + file);
      assert.equal(file.includes('..'), false, 'parent dir in ' + file);
      assert.ok(file.endsWith('.jsonl'), 'suffix missing in ' + file);
      assert.ok(
        file.startsWith('chat') || file.startsWith('g') || file.startsWith('u'),
        'readable prefix missing in ' + file,
      );
    }
  });
});

// --- verifier follow-up: case folding, lone surrogates, empty id convention ---

test('g:A and g:a are separate conversations on a case-insensitive filesystem', async () => {
  await withMemory(async (memory) => {
    await memory.append('g:A', { role: 'user', text: 'upper-secret' });
    await memory.append('g:a', { role: 'user', text: 'lower-secret' });

    assert.deepEqual(await texts(memory, 'g:A'), ['upper-secret']);
    assert.deepEqual(await texts(memory, 'g:a'), ['lower-secret']);
  });
});

test('no two conversations share a file even after case folding', async () => {
  const ids = ['g:A', 'g:a', 'G:a', 'chat/X', 'chat/x', 'u:Z', 'u:z'];

  await withMemory(async (memory, dir) => {
    for (const [index, id] of ids.entries()) {
      await memory.append(id, { role: 'user', text: 'v' + index });
    }

    const files = await readdir(dir);
    assert.equal(files.length, ids.length, 'ids collided on disk: ' + files.join(', '));

    const folded = files.map((file) => file.toLowerCase());
    assert.equal(new Set(folded).size, folded.length, 'case folded names collide: ' + files.join(', '));
  });
});

test('lone surrogates in an id get distinct files', async () => {
  const ids = ['g:\uD800', 'g:\uD801', 'g:\uDC00'];

  await withMemory(async (memory) => {
    for (const [index, id] of ids.entries()) {
      await memory.append(id, { role: 'user', text: 'surrogate-' + index });
    }

    for (const [index, id] of ids.entries()) {
      assert.deepEqual(await texts(memory, id), ['surrogate-' + index], 'id ' + index);
    }
  });
});

test('the empty id keeps a readable prefix and its own file', async () => {
  await withMemory(async (memory, dir) => {
    await memory.append('', { role: 'user', text: 'empty-id' });

    const files = await readdir(dir);
    assert.equal(files.length, 1);
    assert.ok(files[0].startsWith('empty~'), 'empty id lost its prefix: ' + files[0]);

    await memory.append('empty', { role: 'user', text: 'literal-empty' });
    assert.deepEqual(await texts(memory, ''), ['empty-id']);
    assert.deepEqual(await texts(memory, 'empty'), ['literal-empty']);
  });
});

test('filenames carry a 32 hex digest suffix after the readable prefix', async () => {
  await withMemory(async (memory, dir) => {
    await memory.append('chat/a', { role: 'user', text: 'x' });

    const [file] = await readdir(dir);
    assert.match(file, /^chat%2Fa~[0-9a-f]{32}\.jsonl$/);
  });
});

test('overlong ids that differ only in a lone surrogate keep separate digests', async () => {
  const base = 'g:' + 'x'.repeat(200);
  const a = base + '\uD800';
  const b = base + '\uD801';

  await withMemory(async (memory, dir) => {
    await memory.append(a, { role: 'user', text: 'tail-d800' });
    await memory.append(b, { role: 'user', text: 'tail-d801' });

    const files = await readdir(dir);
    assert.equal(files.length, 2, 'the digest collapsed both ids: ' + files.join(', '));
    assert.deepEqual(await texts(memory, a), ['tail-d800']);
    assert.deepEqual(await texts(memory, b), ['tail-d801']);
  });
});

test('two HTTP requests whose group ids differ only in case stay isolated', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'midbot-server-case-'));
  const config = loadConfig({ MIDBOT_RECENT_TURNS: '6' }, dir);
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
  const post = (groupId, text) =>
    fetch(base + '/v1/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({
        post_type: 'message',
        message_type: 'group',
        group_id: groupId,
        user_id: '7',
        raw_message: text,
      }),
    });

  try {
    const first = await post('UPPER', 'first-secret');
    assert.equal(first.status, 200);

    const second = await post('upper', 'second-message');
    assert.equal(second.status, 200);

    assert.equal(
      prompts.at(-1).includes('first-secret'),
      false,
      'history leaked across group ids that differ only in case',
    );
    assert.match(prompts.at(-1), /second-message/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

// --- verifier round 3: id contract and %uXXXX coverage ---

test('non-string conversation ids are rejected by every entry point', async () => {
  await withMemory(async (memory) => {
    for (const bad of [null, undefined, 42, {}, ['chat']]) {
      const label = ' for ' + String(bad);
      await assert.rejects(async () => memory.append(bad, { role: 'user', text: 'x' }), TypeError, 'append' + label);
      await assert.rejects(async () => memory.read(bad), TypeError, 'read' + label);
      await assert.rejects(async () => memory.recent(bad, 2), TypeError, 'recent' + label);
      await assert.rejects(async () => memory.search(bad, 'x'), TypeError, 'search' + label);
    }
  });
});

test('a null id no longer lands in the empty string conversation', async () => {
  await withMemory(async (memory) => {
    await memory.append('', { role: 'user', text: 'empty-string' });
    await assert.rejects(async () => memory.append(null, { role: 'user', text: 'null-row' }), TypeError);

    assert.deepEqual(await texts(memory, ''), ['empty-string']);
    assert.deepEqual(await texts(memory, 'null'), []);
  });
});

test('every non-ASCII code unit is encoded as %uXXXX, Latin-1 included', async () => {
  await withMemory(async (memory, dir) => {
    for (const code of [0x80, 0xe9, 0xff]) {
      await memory.append(String.fromCharCode(code), { role: 'user', text: 'cp-' + code.toString(16) });
    }

    const files = await readdir(dir);
    const expected = ['%u0080', '%u00E9', '%u00FF'];
    for (const prefix of expected) {
      assert.ok(
        files.some((file) => file.startsWith(prefix + '~')),
        'missing ' + prefix + ' in ' + files.join(', '),
      );
    }

    for (const code of [0x80, 0xe9, 0xff]) {
      assert.deepEqual(await texts(memory, String.fromCharCode(code)), ['cp-' + code.toString(16)]);
    }
  });
});
