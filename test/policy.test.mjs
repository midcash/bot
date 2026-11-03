import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPolicy } from '../src/policy.mjs';

// Full config so tests never depend on loadConfig defaults.
function makeConfig(overrides = {}) {
  const base = {
    allowedChats: [],
    allowAll: true,
    rate: { windowMs: 60_000, max: 3 },
    foldThreshold: 100,
  };
  return { ...base, ...overrides, rate: { ...base.rate, ...(overrides.rate ?? {}) } };
}

// Injected clock: rate-limit tests advance fake time instead of sleeping.
function makeClock(start = 1_700_000_000_000) {
  let current = start;
  return {
    now: () => current,
    advance(ms) {
      current += ms;
    },
  };
}

test('allowed: 空白名单 + allowAll=true 时放行任意 chatId', () => {
  const policy = createPolicy(makeConfig({ allowedChats: [], allowAll: true }));
  assert.equal(policy.allowed('any-chat'), true);
  assert.equal(policy.allowed('10001'), true);
});

test('allowed: 空白名单 + allowAll=false 时拒绝所有 chatId', () => {
  const policy = createPolicy(makeConfig({ allowedChats: [], allowAll: false }));
  assert.equal(policy.allowed('any-chat'), false);
  assert.equal(policy.allowed('10001'), false);
});

test('allowed: 白名单非空时只放行名单内的 chatId（allowAll=true 也不例外）', () => {
  const policy = createPolicy(
    makeConfig({ allowedChats: ['10001', '10002'], allowAll: true }),
  );
  assert.equal(policy.allowed('10001'), true);
  assert.equal(policy.allowed('10002'), true);
  assert.equal(policy.allowed('10003'), false);
  // 数字 chatId 会先转成字符串再比较
  assert.equal(policy.allowed(10002), true);
});

test('rateLimited: 窗口内前 max 次放行，第 max+1 次拒绝', () => {
  const clock = makeClock();
  const policy = createPolicy(
    makeConfig({ rate: { windowMs: 1000, max: 3 } }),
    clock.now,
  );

  assert.equal(policy.rateLimited('chat-a'), false);
  clock.advance(100);
  assert.equal(policy.rateLimited('chat-a'), false);
  clock.advance(100);
  assert.equal(policy.rateLimited('chat-a'), false);
  clock.advance(100);
  assert.equal(policy.rateLimited('chat-a'), true);
  // 被拒绝的请求不额外占用配额，窗口内继续拒绝
  assert.equal(policy.rateLimited('chat-a'), true);
});

test('rateLimited: 窗口滑过后恢复放行', () => {
  const clock = makeClock();
  const policy = createPolicy(
    makeConfig({ rate: { windowMs: 1000, max: 3 } }),
    clock.now,
  );

  assert.equal(policy.rateLimited('chat-a'), false); // t=0
  clock.advance(100);
  assert.equal(policy.rateLimited('chat-a'), false); // t=100
  clock.advance(100);
  assert.equal(policy.rateLimited('chat-a'), false); // t=200
  clock.advance(100);
  assert.equal(policy.rateLimited('chat-a'), true); // t=300

  // t=1000：t=0 的那次已滑出窗口，只剩 2 次，重新放行
  clock.advance(700);
  assert.equal(policy.rateLimited('chat-a'), false);
  // 紧接着的下一次又达到上限
  assert.equal(policy.rateLimited('chat-a'), true);
});

test('rateLimited: 不同 chatId 各自计数，互不影响', () => {
  const clock = makeClock();
  const policy = createPolicy(
    makeConfig({ rate: { windowMs: 1000, max: 1 } }),
    clock.now,
  );

  assert.equal(policy.rateLimited('chat-a'), false);
  assert.equal(policy.rateLimited('chat-a'), true);
  // chat-b 的配额不受 chat-a 影响
  assert.equal(policy.rateLimited('chat-b'), false);
  assert.equal(policy.rateLimited('chat-b'), true);
});

test('filter: Windows 盘符路径被替换且不残留原始用户名', () => {
  const policy = createPolicy(makeConfig());
  const input = String.raw`D:\Users\user42\Documents\secret.txt`;

  const out = policy.filter(input);

  assert.notEqual(out, input);
  assert.ok(!out.includes('user42'), `原始用户名仍出现在: ${out}`);
  assert.ok(
    out.includes('<path>') || out.includes('<redacted>'),
    `未包含任何占位符: ${out}`,
  );
  assert.ok(!/[A-Za-z]:\\/.test(out), `盘符路径仍残留: ${out}`);
});

test('filter: /home 路径被替换且不残留原始用户名', () => {
  const policy = createPolicy(makeConfig());
  const input = '文件在 /home/user42/notes.md 里';

  const out = policy.filter(input);

  assert.notEqual(out, input);
  assert.ok(!out.includes('user42'), `原始用户名仍出现在: ${out}`);
  assert.ok(
    out.includes('<path>') || out.includes('<redacted>'),
    `未包含任何占位符: ${out}`,
  );
});

test('filter: sk- 开头的 key 被替换且不残留原文', () => {
  const policy = createPolicy(makeConfig());
  const secret = 'sk-test-0123456789abcdefghij';
  const input = `api key 是 ${secret}`;

  const out = policy.filter(input);

  assert.notEqual(out, input);
  assert.ok(!out.includes(secret), `原始 key 仍出现在: ${out}`);
  assert.ok(!out.includes('0123456789abcdefghij'), `key 主体仍出现在: ${out}`);
  assert.ok(
    out.includes('<path>') || out.includes('<redacted>'),
    `未包含任何占位符: ${out}`,
  );
});

test('filter: 普通文本原样返回', () => {
  const policy = createPolicy(makeConfig());
  const input = '今天天气不错，我们十点见。';
  assert.equal(policy.filter(input), input);
});

test('fold: 短文本原样返回且 folded=false', () => {
  const policy = createPolicy(makeConfig({ foldThreshold: 100 }));
  const input = '短回复';

  const out = policy.fold(input);

  assert.equal(out.folded, false);
  assert.equal(out.text, input);
  assert.equal(out.omitted, 0);
});

test('fold: 长度正好等于 foldThreshold 时不折叠', () => {
  const policy = createPolicy(makeConfig({ foldThreshold: 100 }));
  const input = 'a'.repeat(100);

  const out = policy.fold(input);

  assert.equal(out.folded, false);
  assert.equal(out.text, input);
  assert.equal(out.omitted, 0);
});

test('fold: 超长文本被截断且 folded=true、omitted>0', () => {
  const policy = createPolicy(makeConfig({ foldThreshold: 100 }));
  // 180 字，含换行，确保折叠后总长度仍明显小于原文
  const input = '第一行内容\n'.repeat(30);

  const out = policy.fold(input);

  assert.equal(out.folded, true);
  assert.ok(out.text.length < input.length, `折叠后长度 ${out.text.length} 未变短`);
  assert.ok(out.omitted > 0);
  assert.ok(out.text.startsWith(input.slice(0, 10)), '保留了原文开头');
});

test('fold: 无换行无句号的超长文本仍能折叠并保留开头', () => {
  const policy = createPolicy(makeConfig({ foldThreshold: 100 }));
  const input = 'x'.repeat(300);

  const out = policy.fold(input);

  assert.equal(out.folded, true);
  assert.ok(out.text.length < input.length);
  assert.ok(out.omitted > 0);
  assert.ok(out.text.startsWith('x'.repeat(100)), '保留 foldThreshold 长度的开头');
});
