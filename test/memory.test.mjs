import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMemory } from '../src/memory.mjs';

// Every test gets its own temp dir, removed afterwards; nothing is written to the repo.
async function makeTempMemory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'midbot-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, memory: createMemory(dir) };
}

test('append 后 read 能按写入顺序读回', async (t) => {
  const { memory } = await makeTempMemory(t);

  await memory.append('conv-1', { role: 'user', text: '第一句' });
  await memory.append('conv-1', { role: 'assistant', text: '第二句' });
  await memory.append('conv-1', { role: 'user', text: '第三句' });

  const rows = await memory.read('conv-1');

  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((row) => row.role),
    ['user', 'assistant', 'user'],
  );
  assert.deepEqual(
    rows.map((row) => row.text),
    ['第一句', '第二句', '第三句'],
  );
});

test('append 返回的 row 带 role/text/at，且与读回内容一致', async (t) => {
  const { memory } = await makeTempMemory(t);

  const row = await memory.append('conv-1', { role: 'user', text: '你好' });

  assert.equal(row.role, 'user');
  assert.equal(row.text, '你好');
  assert.equal(typeof row.at, 'string');
  assert.ok(!Number.isNaN(Date.parse(row.at)), `at 不是合法时间: ${row.at}`);

  const rows = await memory.read('conv-1');
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], row);
});

test('recent(n) 只返回最后 n 条且保持旧→新顺序', async (t) => {
  const { memory } = await makeTempMemory(t);
  for (const text of ['1', '2', '3', '4', '5']) {
    await memory.append('conv-1', { role: 'user', text });
  }

  const rows = await memory.recent('conv-1', 2);

  assert.deepEqual(
    rows.map((row) => row.text),
    ['4', '5'],
  );
});

test('recent(n) 的 n 大于总数时返回全部（仍为旧→新顺序）', async (t) => {
  const { memory } = await makeTempMemory(t);
  for (const text of ['a', 'b', 'c']) {
    await memory.append('conv-1', { role: 'user', text });
  }

  const rows = await memory.recent('conv-1', 10);

  assert.deepEqual(
    rows.map((row) => row.text),
    ['a', 'b', 'c'],
  );
});

test('不同 conversationId 之间互不可见', async (t) => {
  const { memory } = await makeTempMemory(t);

  await memory.append('conv-1', { role: 'user', text: '一号会话' });
  await memory.append('conv-2', { role: 'user', text: '二号会话' });

  const first = await memory.read('conv-1');
  const second = await memory.read('conv-2');

  assert.deepEqual(
    first.map((row) => row.text),
    ['一号会话'],
  );
  assert.deepEqual(
    second.map((row) => row.text),
    ['二号会话'],
  );
  assert.ok(!first.some((row) => row.text === '二号会话'));
  assert.ok(!second.some((row) => row.text === '一号会话'));
});

test('不存在的 conversationId read 返回空数组而不抛错', async (t) => {
  const { memory } = await makeTempMemory(t);

  const rows = await memory.read('never-written');
  const recent = await memory.recent('never-written', 3);

  assert.deepEqual(rows, []);
  assert.deepEqual(recent, []);
});

test('含特殊字符的 conversationId 不报错且仍然隔离', async (t) => {
  const { memory } = await makeTempMemory(t);
  const weirdId = 'conv:1/2 3';
  const otherId = 'conv:1/2 4';

  await memory.append(weirdId, { role: 'user', text: '特殊 id' });
  await memory.append(otherId, { role: 'user', text: '另一个 id' });

  const weirdRows = await memory.read(weirdId);
  const otherRows = await memory.read(otherId);

  assert.deepEqual(
    weirdRows.map((row) => row.text),
    ['特殊 id'],
  );
  assert.deepEqual(
    otherRows.map((row) => row.text),
    ['另一个 id'],
  );
});

test('memory 只把 jsonl 文件写在给定目录下', async (t) => {
  const { dir, memory } = await makeTempMemory(t);

  await memory.append('conv-1', { role: 'user', text: 'hi' });

  const files = await readdir(dir);
  assert.equal(files.length, 1);
  assert.ok(files[0].endsWith('.jsonl'), `意外文件: ${files[0]}`);
});
