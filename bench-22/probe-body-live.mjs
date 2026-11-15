#!/usr/bin/env node
/**
 * 在一个**已经建好**的库上跑真实 `memory_search`，输出每题命中的 ref 列表。
 *
 * 存在的理由：`ctx-only.py` 每换一个 `eventBodyWeight` 都要重放一遍历史（11 分钟），
 * 而权重只影响检索、不影响写入。所以扫描阶段用这个：同一个库、同一批问句，
 * 只换配置，答案逐题可比。
 *
 *   node bench-22/probe-body-live.mjs --db <loom.db> --items q.jsonl --weight 2.0 --out r.jsonl
 *
 * 库会先复制到临时目录：`node:sqlite` 打开原库会拿写锁，而我们要连开好几档。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLoom } from '../loom-e2e/harness.mjs';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
	const key = process.argv[i].replace(/^--/, '');
	args.set(key, process.argv[i + 1]);
}
const dbIn = args.get('db');
const itemsPath = args.get('items');
const outPath = args.get('out');
const weight = Number(args.get('weight') ?? 0);
const limit = Number(args.get('limit') ?? 10);
const sid = args.get('sid') ?? 'M02';

if (!dbIn || !itemsPath || !outPath) {
	console.error('用法: --db <loom.db> --items <q.jsonl> --out <r.jsonl> [--weight 2.0] [--limit 10] [--sid M02]');
	process.exit(2);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-live-'));
const dbPath = path.join(work, 'loom.db');
fs.copyFileSync(dbIn, dbPath);
for (const suffix of ['-wal', '-shm']) {
	if (fs.existsSync(dbIn + suffix)) fs.copyFileSync(dbIn + suffix, dbPath + suffix);
}

const loom = createLoom({
	dbPath,
	config: { retrieval: { eventBodyWeight: weight } },
	settleRounds: 1
});

const items = fs
	.readFileSync(itemsPath, 'utf8')
	.split(/\r?\n/)
	.filter((line) => line.trim().length > 0)
	.map((line) => JSON.parse(line));

const out = fs.createWriteStream(outPath, { encoding: 'utf8' });
for (const item of items) {
	let text = '';
	try {
		text = String(await loom.call('memory_search', { query: item.q, limit }, sid));
	} catch (error) {
		text = `ERROR ${error instanceof Error ? error.message : String(error)}`;
	}
	/*
	* 只留指针，不留正文：这一步要比的是「哪一行进了列表」，正文长度是另一把
	* 尺子（`cmp-tail.py` 的字符列），两件事分开看。
	*/
	const refs = [...text.matchAll(/#([FEPL]\d+(?:-\d+)?)/gu)].map((match) => match[1]);
	const rows = (text.match(/^\s*\d+\. \[/gmu) ?? []).length;
	out.write(`${JSON.stringify({ id: item.id, refs, rows, chars: text.length })}\n`);
}
out.end();
loom.dispose?.();
console.log(`wrote ${outPath} (weight=${weight}, ${items.length} items, ${dbIn})`);
