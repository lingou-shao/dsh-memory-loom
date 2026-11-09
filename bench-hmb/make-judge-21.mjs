/**
 * 2.1 判分材料：把答案键的评分标准与系统回答拼成逐题卡片，切成若干批。
 *
 * 与 1.0 那套（make-judge-batches.mjs）的区别：2.1 的通过判据除了 required 还有
 * forbidden / tempting_fabrications / unknown / date_math 四道，压成一行会丢掉判断依据，
 * 所以这里一题一小块，块内保留全部字段。
 *
 *   node bench-hmb/make-judge-21.mjs <answers.jsonl> <outDir> [每批题数]
 */
import fs from 'node:fs';
import path from 'node:path';

const ANSWERS = process.argv[2];
const OUT = process.argv[3] ?? path.join(path.dirname(ANSWERS), 'judge');
const PER_BATCH = Number(process.argv[4] ?? 26);
const DS = process.env.CMB21_DIR ?? 'C:/Users/shaoz/Desktop/chat-memory-bench/benchmark-2.1/dataset';

const jsonl = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
const inputs = new Map(jsonl(path.join(DS, 'exam-inputs.jsonl')).map((row) => [row.id, row]));
const keys = new Map(jsonl(path.join(DS, 'answer-key.jsonl')).map((row) => [row.id, row]));
const answers = new Map(jsonl(ANSWERS).map((row) => [row.id, row]));

const numbered = (list) => (list && list.length > 0 ? list.map((one, i) => `${i}) ${one}`).join(' ／ ') : '——');

const blocks = [];
for (const [id, key] of keys) {
	const exam = inputs.get(id) ?? {};
	const answer = answers.get(id)?.answer ?? '（无作答）';
	const rubric = key.rubric ?? {};
	const dateMath = key.date_math ? JSON.stringify(key.date_math) : '无';
	const lines = [
		`【${id}】${key.persona} · ${key.kind ?? 'main'} · ${key.probe_type ?? 'legacy'} · 现在 ${exam.now ?? ''}`,
		`Q: ${exam.question ?? ''}`,
		`R: ${numbered(rubric.required)}`,
		`F: ${numbered(rubric.forbidden)}`,
		`T: ${numbered(rubric.tempting_fabrications)}`,
		`U: ${numbered(rubric.unknown)}`,
		`D: ${dateMath}`,
		`参考答案: ${key.reference_answer ?? '（无）'}`,
		`答: ${String(answer).replace(/\s*\n+\s*/gu, ' ').trim()}`
	];
	blocks.push({ id, text: lines.join('\n'), raw: { id, key, exam, answer } });
}

fs.mkdirSync(OUT, { recursive: true });
const batches = [];
for (let i = 0; i < blocks.length; i += PER_BATCH) batches.push(blocks.slice(i, i + PER_BATCH));
batches.forEach((batch, index) => {
	const name = String(index).padStart(2, '0');
	fs.writeFileSync(path.join(OUT, `batch-${name}.txt`), batch.map((one) => one.text).join('\n\n') + '\n', 'utf8');
	fs.writeFileSync(path.join(OUT, `detail-${name}.jsonl`), batch.map((one) => JSON.stringify(one.raw)).join('\n') + '\n', 'utf8');
	console.log(`batch-${name}.txt`, batch.length, '题', batch.reduce((sum, one) => sum + one.text.length, 0), 'chars');
});
console.log('总计', blocks.length, '题 /', batches.length, '批 →', OUT);
