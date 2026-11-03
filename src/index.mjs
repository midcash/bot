import { mkdir } from 'node:fs/promises';
import { loadConfig } from './config.mjs';
import { createPolicy } from './policy.mjs';
import { createMemory } from './memory.mjs';
import { createBrain } from './brain.mjs';
import { createServer } from './server.mjs';

const config = loadConfig();

for (const dir of [config.sandboxDir, config.sessionDir, config.memoryDir]) {
  if (dir) await mkdir(dir, { recursive: true });
}

const policy = createPolicy(config);
const memory = createMemory(config.memoryDir);
const brain = createBrain(config);
const server = createServer({ config, brain, memory, policy });

server.listen(config.port, config.host, () => {
  console.log('midbot listening on http://' + config.host + ':' + config.port);
  console.log('model: ' + config.model);
});
