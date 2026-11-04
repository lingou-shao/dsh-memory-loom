/** 冒烟：走 episode 桥，3 段语料，验证「写入 → 整合 → 检索 → 调回原文」全链。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const BENCH = 'C:/Users/shaoz/Documents/GitHub/hive-memory-bench-main';
const corpus = JSON.parse(fs.readFileSync(path.join(BENCH, 'chain/corpus/corpus.json'), 'utf8'));
const keys = JSON.parse(fs.readFileSync(path.join(BENCH, 'chain/keys/keys.json'), 'utf8'));

const db = path.join(os.tmpdir(), `loom-ep-${Date.now()}.db`);
const proc = spawn('node', ['bench-hmb/loom_bridge_episode.mjs'], {
  env: { ...process.env, HMB_LOOM_DB: db },
  stdio: ['pipe', 'pipe', 'inherit'],
});

let buf = '';
const waiters = [];
proc.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    waiters.shift()?.(JSON.parse(line));
  }
});
const rpc = (o) => new Promise((res) => {
  waiters.push(res);
  proc.stdin.write(`${JSON.stringify(o)}\n`);
});

const t0 = Date.now();
const ing = await rpc({ op: 'ingest', mode: 'episode', chapters: corpus.slice(0, 3) });
console.log('ingest:', ing, `${Date.now() - t0}ms`);

const q = keys.find((k) => k.type === '现值');
console.log('\nq:', q.question);
const r = await rpc({ op: 'retrieve', query: `${q.subject} ${q.slot}`, k: 6 });
console.log('hits:', r.hits?.length);
for (const h of r.hits ?? []) {
  console.log(` [${h.ref}] cid=${h.cid} ${h.text.length}字 | ${h.text.slice(0, 90).replace(/\n/g, ' ')}`);
}
await rpc({ op: 'close' });
proc.kill();
console.log('\ndb:', db);
