/**
 * 三份 714 产物的逐题比对（只读，不随产品发布）。
 *
 * 判据与 `surface-coverage.mjs` 的汇总一致：一道题算「到了」当且仅当它的**每一条**
 * 计分事实的 r10 都 ≥ 0.8。逐题摊开是为了分清「加了东西」和「换了东西」——
 * 汇总分数一样时，前者是净增，后者是一进一出。
 *
 *   node bench-hmb/diff-surface.mjs <baseline.jsonl> <candidate.jsonl>
 */
import fs from 'node:fs';
import path from 'node:path';

const BENCH = process.env.HMB_DIR ?? 'C:/Users/shaoz/Desktop/chat-memory-bench';
const read = (name) => new Map(fs.readFileSync(path.join(BENCH, name), 'utf8').trim().split('\n').map((line) => JSON.parse(line)).map((row) => [row.id, row]));
const covered = (row, field) => row.facts.length > 0 && row.facts.every((fact) => (fact[field] ?? 0) >= 0.8);

const [baseName, candName] = process.argv.slice(2);
if (baseName === void 0 || candName === void 0) {
	console.error('用法: node diff-surface.mjs <baseline.jsonl> <candidate.jsonl>');
	process.exit(1);
}
const base = read(baseName);
const cand = read(candName);

for (const field of ['toolR10', 'searchR10', 'blockR10']) {
	const gain = [];
	const loss = [];
	for (const [id, row] of base) {
		const other = cand.get(id);
		if (other === void 0) continue;
		const a = covered(row, field);
		const b = covered(other, field);
		if (a === b) continue;
		(b ? gain : loss).push({ id, question: row.question });
	}
	console.error(`${field}: 变好 ${gain.length} · 变差 ${loss.length}`);
	for (const one of gain) console.error(`   + ${one.id}  ${one.question.replace(/\n/gu, ' | ').slice(0, 56)}`);
	for (const one of loss) console.error(`   - ${one.id}  ${one.question.replace(/\n/gu, ' | ').slice(0, 56)}`);
	console.error('');
}
