/**
 * 把 `memory_search` 的输出逐题倒出来，用于跨版本逐字对比（2026-11-13）。
 *
 * 换检索内部的读法（文档频率改从词表读、频率缓存、`topicAnchor` 只为赢家取行）
 * 之后，最硬的证据不是读数没变，而是**同一批题、同一个库，两个版本吐出的字符串
 * 逐字节相同**。读数只覆盖「证据有没有到」，覆盖不到行序、覆盖不到措辞。
 *
 *   node bench-22/dump-search.mjs --root <repo> --db <db> --out <file> --n 40
 *
 * `--root` 指向哪个工作树，就加载哪个版本的 `lib/`（旧版用 `git worktree` 拉出来）。
 * 库会被复制到临时目录再用，两个版本各自从**同一份原始状态**开始。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname).replace(/^\/(?=[A-Za-z]:)/, '');
const arg = (name, fallback) => {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : fallback;
};
const ROOT = path.resolve(arg('root', path.join(HERE, '..')));
const dbIn = path.resolve(arg('db', path.join(HERE, 'work', 'cmp-m02.db')));
const outPath = path.resolve(arg('out', path.join(HERE, 'work', 'dump.jsonl')));
const PERSONA = arg('persona', 'M02');
const N = Number(arg('n', 40));
const LIMIT = Number(arg('limit', 10));

const DATA = [
	path.join(os.homedir(), 'Desktop', 'cmb-2.2', 'benchmark-2.2', 'dataset'),
	path.join(HERE, '..', '..', 'cmb-2.2', 'benchmark-2.2', 'dataset'),
].find((one) => fs.existsSync(path.join(one, 'exam-inputs.jsonl')));

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-dump-'));
const copy = path.join(work, 'loom.db');
fs.copyFileSync(dbIn, copy);
for (const suffix of ['-wal', '-shm']) {
	if (fs.existsSync(dbIn + suffix)) fs.copyFileSync(dbIn + suffix, copy + suffix);
}

const { createLoom } = await import(`file:///${path.join(ROOT, 'loom-e2e', 'harness.mjs').replaceAll('\\', '/')}`);
const loom = createLoom({ dbPath: copy, config: { consolidation: { triggerTokens: 0 } }, settleRounds: 1 });

const questions = fs
	.readFileSync(path.join(DATA, 'exam-inputs.jsonl'), 'utf8')
	.split('\n')
	.filter((line) => line.trim())
	.map((line) => JSON.parse(line))
	.filter((row) => row.persona === PERSONA)
	.slice(0, N);

const lines = [];
for (const item of questions) {
	const text = String(await loom.call('memory_search', { query: item.question, limit: LIMIT }, PERSONA));
	lines.push(JSON.stringify({ id: item.id, question: item.question, text }));
}
fs.writeFileSync(outPath, lines.join('\n') + '\n');
console.log(`${questions.length} 题 → ${outPath}`);

loom.dispose?.();
await new Promise((resolve) => setTimeout(resolve, 100));
try {
	fs.rmSync(work, { recursive: true, force: true });
} catch {
	/* 临时目录清不掉不影响结论 */
}
