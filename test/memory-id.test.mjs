import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemory } from '../src/memory.mjs';

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
