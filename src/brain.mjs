import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';

// The brain is a restricted pi instance: no built-in tools, no extensions, no
// MCP, no project context files. It can only produce text.
const SAFE_ARGS = [
  '-p',
  '--mode', 'json',
  '--no-tools',
  '--no-extensions',
  '--no-mcp',
  '--no-skills',
  '--no-context-files',
  '--no-approve',
];

function quoteForShell(arg) {
  if (!/[ \t"]/.test(arg)) return arg;
  return '"' + arg.replace(/"/g, '\\"') + '"';
}

function resolveCommand(config) {
  if (config.piEntry) {
    return { command: process.execPath, args: [config.piEntry], shell: false };
  }
  if (process.platform === 'win32') {
    // npm global bins are .cmd shims on Windows; they need a shell.
    return { command: config.piBin, args: [], shell: true };
  }
  return { command: config.piBin, args: [], shell: false };
}

function textOf(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && block.type === 'text')
    .map((block) => block.text)
    .join('');
}

export function createBrain(config) {
  async function ask({ sessionId, prompt, signal }) {
    const started = Date.now();
    await mkdir(config.sandboxDir, { recursive: true });
    if (config.sessionDir) await mkdir(config.sessionDir, { recursive: true });

    const args = [
      ...SAFE_ARGS,
      '--model', config.model,
      '--thinking', config.thinking,
      '--session-id', sessionId,
    ];
    if (config.sessionDir) args.push('--session-dir', config.sessionDir);

    const base = resolveCommand(config);
    const invocation = base.shell
      ? {
          command: [base.command, ...base.args, ...args].map(quoteForShell).join(' '),
          args: [],
          shell: true,
        }
      : { command: base.command, args: [...base.args, ...args], shell: false };

    return new Promise((resolve) => {
      let settled = false;
      const child = spawn(invocation.command, invocation.args, {
        cwd: config.sandboxDir,
        shell: invocation.shell,
        windowsHide: true,
        env: { ...process.env, NO_COLOR: '1' },
      });

      let stdout = '';
      let stderr = '';
      let killedForTimeout = false;

      const timer = setTimeout(() => {
        killedForTimeout = true;
        child.kill('SIGKILL');
      }, config.brainTimeoutMs);

      const finish = (extra) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(guard);
        resolve({
          ok: !extra.error,
          text: extra.text || '',
          usage: extra.usage || null,
          error: extra.error || null,
          code: extra.code ?? null,
          ms: Date.now() - started,
        });
      };

      // pi can exit before its stdio drains; give the pipes a moment.
      const guard = setTimeout(() => finish({ text: lastText, error: killedForTimeout ? 'timeout' : null }), config.brainTimeoutMs + 5000);

      let lastText = '';
      let usage = null;

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        const lines = stdout.split('\n');
        stdout = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let event;
          try {
            event = JSON.parse(trimmed);
          } catch {
            continue;
          }
          if (event.type === 'message_end' && event.message?.role === 'assistant') {
            lastText = textOf(event.message);
            usage = event.message.usage ?? usage;
          }
        }
      });

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
        if (stderr.length > 4000) stderr = stderr.slice(-4000);
      });

      child.on('error', (error) => finish({ error: 'spawn: ' + error.message }));
      child.on('close', (code) => {
        if (killedForTimeout) return finish({ error: 'timeout', code });
        if (code !== 0) return finish({ error: 'exit ' + code + ': ' + stderr.trim().slice(-300), code });
        finish({ text: lastText.trim(), usage, code });
      });

      child.stdin.end(prompt, 'utf8');
    });
  }

  return { ask };
}

export function piEntryExists(entry) {
  return Boolean(entry) && existsSync(entry);
}
