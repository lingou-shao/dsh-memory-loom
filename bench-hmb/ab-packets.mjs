#!/usr/bin/env node
/*
 * A/B 作答包：同一批题、两版记忆、同一个作答者、盲标（§81.7 第 1 步）。
 *
 * 缘由：0.2.55–0.2.58 的端到端读数是「平」，但那套链路里作答换了 40 个子代理、
 * 判分换了 28 个，产品差（≤1 点）被作答方差（≈2 点）盖住。要测出 1 个点，只能
 * 把「记忆侧」以外的变量全钉死：
 *
 *   - 同一份题单（`ab-ids.json`，默认是两个薄弱考点的并集）
 *   - 每题两臂，`memory` 只换取面产物，其余字段逐字相同
 *   - 盲标：臂号不写进 id，`#k` 的 k 由题号哈希决定，两臂各占一半，
 *     作答者既看不出哪条新、也看不出哪两条是一对
 *   - 顺序打散，同题两臂不相邻
 *
 * 用法：
 *   node bench-hmb/ab-packets.mjs <A.jsonl> <B.jsonl> <ids.json> <outDir> \
 *        [--packets <packets.jsonl>] [--per-batch 24] [--max-chars 40000]
 *
 * 产出：
 *   <outDir>/batch-000.jsonl…   作答输入（id/now/question/memory）
 *   <outDir>/key.json           { blindId: { id, arm } }，作答与判分期间不给模型看
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const argOf = (name, fallback) => {
	const i = process.argv.indexOf(`--${name}`);
	return i === -1 ? fallback : process.argv[i + 1];
};
const [, , A_FILE, B_FILE, IDS_FILE, OUT_DIR] = process.argv;
if (!A_FILE || !B_FILE || !IDS_FILE || !OUT_DIR) {
	console.error('用法: node ab-packets.mjs <A.jsonl> <B.jsonl> <ids.json> <outDir> [--packets p] [--per-batch n]');
	process.exit(1);
}
const PER_BATCH = Number(argOf('per-batch', 24));
const MAX_CHARS = Number(argOf('max-chars', 40000));

const jsonl = (file) =>
	fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
const byId = (file) => new Map(jsonl(file).map((one) => [one.id, one]));

const armA = byId(A_FILE);
const armB = byId(B_FILE);
const ids = JSON.parse(fs.readFileSync(IDS_FILE, 'utf8'));

/** 与 `make-answer-input.mjs` 同一套拼法：常驻块 + 搜索行 + 展开正文。 */
const memoryOf = (row) => {
	const block = String(row.context?.block ?? '').trim();
	const search = String(row.context?.search ?? '').trim();
	const expanded = (row.context?.expanded ?? []).map((one) => String(one.text ?? '').trim()).join('\n\n');
	return [`【自动注入】\n${block}`, `【搜索】\n${search}`, `【展开】\n${expanded}`]
		.filter((part) => part.trim().length > 6)
		.join('\n\n');
};

/** 臂号按题号哈希分，`#1`/`#2` 里哪个新哪个旧是掷出来的，不是排出来的。 */
const tagFor = (id) => (crypto.createHash('sha1').update(id).digest()[0] % 2 === 0 ? '1' : '2');

const items = [];
const key = {};
const missing = [];
for (const id of ids) {
	const a = armA.get(id);
	const b = armB.get(id);
	if (!a || !b) {
		missing.push(id);
		continue;
	}
	const tag = tagFor(id);
	const pairs = [
		[`${id}#${tag}`, tag === '1' ? 'A' : 'B'],
		[`${id}#${tag === '1' ? '2' : '1'}`, tag === '1' ? 'B' : 'A']
	];
	for (const [blind, arm] of pairs) {
		const row = arm === 'A' ? a : b;
		items.push({ id: blind, now: row.now, question: row.question, memory: memoryOf(row) });
		key[blind] = { id, arm };
	}
}

/* 打散，同题两臂不相邻。固定种子，重跑得到同一个顺序。 */
const seedOf = (text) => crypto.createHash('sha1').update(text).digest().readUInt32BE(0);
items.sort((x, y) => seedOf(`s:${x.id}`) - seedOf(`s:${y.id}`));

fs.mkdirSync(OUT_DIR, { recursive: true });
const batches = [];
let current = [];
let chars = 0;
for (const item of items) {
	const size = JSON.stringify(item).length;
	if (current.length > 0 && (current.length >= PER_BATCH || chars + size > MAX_CHARS)) {
		batches.push(current);
		current = [];
		chars = 0;
	}
	current.push(item);
	chars += size;
}
if (current.length > 0) batches.push(current);
batches.forEach((batch, index) => {
	fs.writeFileSync(
		path.join(OUT_DIR, `batch-${String(index).padStart(3, '0')}.jsonl`),
		batch.map((one) => JSON.stringify(one)).join('\n') + '\n',
		'utf8'
	);
});
fs.writeFileSync(path.join(OUT_DIR, 'key.json'), JSON.stringify(key, null, 1), 'utf8');

const arms = Object.values(key).reduce((acc, one) => ({ ...acc, [one.arm]: (acc[one.arm] ?? 0) + 1 }), {});
console.log('题', ids.length, '缺面', missing.length, missing.slice(0, 5));
console.log('条目', items.length, arms, '包', batches.length);
console.log('包大小', batches.map((batch) => batch.length).join(','));
