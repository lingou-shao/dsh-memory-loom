/**
 * 把作答输入包（每行一个 JSON）转成逐题文本，供子代理用 Read 直接读。
 *
 * 为什么需要：batch jsonl 每行是完整 JSON，memory 字段动辄一两千字，单行远超
 * Read 工具 2000 字符的截断上限，子代理会读到残行、答案跟着缺料。转成 md 之后
 * 单行长度就是记忆文本原本的行长（几十字），Read 能完整读出。
 *
 *   node bench-hmb/mdify-answer-input.mjs <answers-in 目录> <out 目录>
 */
import fs from 'node:fs';
import path from 'node:path';

const SRC = process.argv[2];
const OUT = process.argv[3];
if (!SRC || !OUT) {
	console.error('用法: node mdify-answer-input.mjs <answers-in 目录> <out 目录>');
	process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });

for (const file of fs.readdirSync(SRC).filter((f) => f.endsWith('.jsonl')).sort()) {
	const rows = fs
		.readFileSync(path.join(SRC, file), 'utf8')
		.trim()
		.split('\n')
		.filter(Boolean)
		.map((line) => JSON.parse(line));
	const parts = rows.map((row, i) => {
		const body = String(row.memory ?? '')
			.split('\n')
			.map((line) => (line.trim() === '' ? '' : `  ${line}`))
			.join('\n');
		return [
			`### ${i + 1}/${rows.length}`,
			`id: ${row.id}`,
			`now: ${row.now}`,
			'',
			`问：${row.question}`,
			'',
			'记忆：',
			body,
			''
		].join('\n');
	});
	const out = path.join(OUT, file.replace(/\.jsonl$/, '.md'));
	fs.writeFileSync(out, `# 作答包 ${file}（共 ${rows.length} 题）\n\n${parts.join('\n---\n\n')}`, 'utf8');
	console.log(out, rows.length, '题', fs.statSync(out).size, 'B');
}
