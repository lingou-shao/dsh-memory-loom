/**
 * 2.1 适配前的口径探针：会话切分到底影响多少。
 *
 * 2.1 的历史按「会话」切开（M01 235 个、M02 144 个），而 1.0 那套脚本是整条人物
 * 一个 SID 灌到底的。灌法不同，注入块里「最近几轮」的来源就不同：整条 SID 的话，
 * 块里永远是最后几轮；按会话切的话，块里是「当前会话的最近几轮」。
 *
 * 这个探针只回答一件事：**换一个新 SID 去问，注入块还剩多少**。
 * 剩得多（人物卡 + 分层记忆），按会话切没有代价；剩得只剩个壳，就得沿用整条 SID。
 *
 *   node bench-hmb/probe-21-session.mjs <history.jsonl> [灌多少轮]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLoom, MIN } from '../loom-e2e/harness.mjs';

const file = process.argv[2];
const LIMIT = Number(process.argv[3] ?? 120);
if (!file) {
	console.error('用法: node probe-21-session.mjs <history.jsonl> [轮数]');
	process.exit(1);
}

const turns = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line)).slice(0, LIMIT);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe21-'));
const dbPath = path.join(dir, 'loom.db');

const realNow = Date.now;
let clock = Date.parse(turns[0]['逻辑时间']);
Date.now = () => clock;

const loom = createLoom({ dbPath, config: { consolidation: { triggerTokens: 0 } } });
let previous = null;
for (const turn of turns) {
	const at = Date.parse(turn['逻辑时间']);
	clock = at;
	const sid = `p-${turn['会话']}`;
	await loom.turn(sid, turn['用户消息'], turn['助手回复'], { at });
	previous = at;
}

const lastSid = `p-${turns[turns.length - 1]['会话']}`;
const blockLast = String(loom.memoryBlock(lastSid));
const blockFresh = String(loom.memoryBlock('p-exam-fresh'));
clock = Math.max(clock, previous + MIN);
const query = '我四月十七的生日，你还记得吗';
const search = String(await loom.call('memory_search', { query, limit: 10 }, lastSid));

const head = (text, n = 22) => text.trim().split('\n').slice(0, n).join('\n');
console.log(`灌了 ${turns.length} 轮 / ${new Set(turns.map((t) => t['会话'])).size} 个会话`);
console.log(`\n=== 当前会话（${lastSid}）的注入块 ${blockLast.length} 字\n${head(blockLast)}`);
console.log(`\n=== 全新会话的注入块 ${blockFresh.length} 字\n${head(blockFresh)}`);
console.log(`\n=== 搜索行 ${search.length} 字\n${head(search, 8)}`);
loom.dispose?.();
Date.now = realNow;
