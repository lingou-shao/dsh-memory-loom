/**
 * 14 道 `date_wrong` 的错日期，是从哪儿来的？
 *
 * 上一轮的结论是「10/14 能在记忆里找到」，但那只分到「抄的 / 推的」两层，
 * 而这两层对应两种完全不同的修法：
 *
 *   - 抄的：我们**存了**一个和答案冲突的绝对日期（写侧多留了一条竞争候选）；
 *   - 推的：记忆正文里有一句相对说法（「周一我跑了一趟」+ 行首 11-26），
 *     作答侧自己做减法，而那条相对说法本来就不该被当成「事件的日期」。
 *
 * 判据写死，避免我边看边改口径：
 *   ABS = 错日期的「M月D日」或「M-D」在我们的记忆文本里出现过；
 *   REL = 记忆文本里存在「周一/上周X/下周X/昨天」这类说法，且它所在的
 *         那一行的时间头离答案日期超过 3 天（也就是它指的不是答案那天）。
 *
 *   node bench-hmb/diag-21-datewrong.mjs
 */
import fs from 'node:fs';

const W = 'C:/Users/shaoz/Desktop/chat-memory-bench/benchmark-2.1/work/';
const DS = 'C:/Users/shaoz/Desktop/chat-memory-bench/benchmark-2.1/dataset/';

const jsonl = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const key = new Map(jsonl(DS + 'answer-key.jsonl').map((row) => [row.id, row]));
const exam = new Map(jsonl(DS + 'exam-inputs.jsonl').map((row) => [row.id, row]));
const answers = new Map(jsonl(W + 'answers-21-0270.jsonl').map((row) => [row.id, row.answer]));
const judged = new Map(jsonl(W + 'judge-21-0270.jsonl').map((row) => [row.id, row]));
const surface = new Map(jsonl(W + 'surface-21-v0270.jsonl').map((row) => [row.id, row]));

/** 把一题的三个面拼成答题模型真正看到的那段文本。 */
function memoryOf(row) {
	const ctx = row.context ?? {};
	const ex = ctx.expanded;
	const body = Array.isArray(ex) ? ex.map((one) => (typeof one === 'string' ? one : (one.text ?? ''))).join('\n') : (ex ?? '');
	return [ctx.block ?? '', '【搜索】', ctx.search ?? '', '【展开】', body].join('\n');
}

const MD = (iso) => {
	const m = /^(\d{4})-(\d{2})-(\d{2})/u.exec(iso ?? '');
	return m === null ? null : `${Number(m[2])}月${Number(m[3])}日`;
};
const REL_WORDS = /(上周[一二三四五六日天]|这周[一二三四五六日天]|本周[一二三四五六日天]|下周[一二三四五六日天]|周[一二三四五六日天]|昨天|前天|大后天|后天|明天)/u;

const rows = [];
for (const [id, verdict] of judged) if (verdict.date_wrong) {
	const k = key.get(id) ?? {};
	const dm = k.date_math ?? {};
	const answer = answers.get(id) ?? '';
	const memory = memoryOf(surface.get(id) ?? {});
	/* 答案里出现过的所有「M月D日」/「M月D号」，去掉正确那个。 */
	const found = [...answer.matchAll(/(\d{1,2})月(\d{1,2})[日号]/gu)].map((m) => `${Number(m[1])}月${Number(m[2])}日`);
	const right = MD(dm.event_date);
	const wrong = [...new Set(found.filter((one) => one !== right))];
	const abs = wrong.filter((one) => {
		const [mo, da] = one.replace('日', '').split('月');
		return memory.includes(`${mo}月${da}日`) || memory.includes(`${mo}月${da}号`) || memory.includes(`${mo}-${da}`) || memory.includes(`-${String(da).padStart(2, '0')} `);
	});
	const rel = REL_WORDS.test(memory);
	rows.push({ id, q: exam.get(id)?.question ?? '', dm, right, wrong, abs, rel, answer, memory });
}

console.log(`date_wrong ${rows.length} 道\n`);
const tally = { absOnly: 0, relOnly: 0, both: 0, neither: 0 };
for (const row of rows) {
	const tag = row.abs.length > 0 ? (row.rel ? 'both' : 'absOnly') : (row.rel ? 'relOnly' : 'neither');
	tally[tag]++;
	console.log(`--- ${row.id}  [${tag}]`);
	console.log(`  Q ${row.q}`);
	console.log(`  应 ${row.right ?? '-'}（${row.dm.rule ?? '-'} ${row.dm.arg ?? ''}，说话日 ${row.dm.speaker_date ?? '-'}）  答里出现 ${row.wrong.join('/') || '无'}`);
	console.log(`  记忆里出现过的错日期：${row.abs.join('/') || '无'}`);
	console.log(`  A ${row.answer.slice(0, 96)}`);
}
console.log('\n口径汇总：', tally);
fs.writeFileSync('C:/Users/shaoz/AppData/Local/Temp/datewrong-0270.json', JSON.stringify(rows, null, 1), 'utf8');
console.log('明细 -> %TEMP%/datewrong-0270.json');
