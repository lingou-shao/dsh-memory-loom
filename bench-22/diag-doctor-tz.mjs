import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLoom } from '../loom-e2e/harness.mjs';

const root = mkdtempSync(join(tmpdir(), 'doc-tz-'));
const loom = createLoom({ dbPath: join(root, 'loom.db') });
const S = 'probe-stray-due';
await loom.call('memory_write', { text: '用户在写一个记忆插件', kind: 'fact' }, S);
await loom.call('memory_write', { text: '用户上次用的是另一个存储引擎', kind: 'fact' }, S);
console.log('TZ env =', process.env.TZ ?? '(未设置)', '| 系统解析 =', Intl.DateTimeFormat().resolvedOptions().timeZone);
console.log('──────────────── doctor ────────────────');
console.log(String(await loom.call('memory_doctor', {}, S)));
loom.dispose();
rmSync(root, { recursive: true, force: true });
