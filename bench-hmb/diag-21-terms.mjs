/**
 * 稀有词直查的**挑词上界**（§91.2）。
 *
 * 问题不是「直查能不能救回来」——`probe-21-rare-direct.mjs` 量到能，29 道里
 * 15 道。问题是探针用了一个产品拿不到的东西：它挑的是**与承载行共享**的那个词。
 * 产品里只能从问句侧挑，于是必须先回答「挑得到吗」。
 *
 * 这个脚本不建库、不检索，只在题库文本上算一件事：问句里 DF 最小的那几个内容
 * 词，包不包括那个与答案锚点共享的词。三种挑法对比：
 *
 *   ① 问句直挑      —— 0.2.64 第一版的做法
 *   ② 直挑但 DF≥2   —— 只滤掉 DF=1 的碎片
 *   ③ 候选行反馈    —— 从「与问句共享 ≥2 个内容词」的前 10 轮里学，且要求该词
 *                      出现在 ≥2 轮里（`learnedTerms` 的做法）
 *
 * 用：node bench-hmb/diag-21-terms.mjs [--show 12]
 */
import fs from 'node:fs';

const DS = 'C:/Users/shaoz/Desktop/chat-memory-bench/benchmark-2.1/dataset';
const W = 'C:/Users/shaoz/Desktop/chat-memory-bench/benchmark-2.1/work';
const argOf = (name, fallback) => {
	const at = process.argv.indexOf(`--${name}`);
	return at === -1 ? fallback : process.argv[at + 1];
};
const SHOW = Number(argOf('show', 8));
const ONLY = argOf('kind', '');

const jsonl = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const evidence = JSON.parse(fs.readFileSync(`${W}/diag-evidence.json`, 'utf8'));
const misses = (evidence.rows ?? evidence).filter((one) => one.kind !== undefined && (ONLY === '' || one.kind === ONLY));
const keys = new Map(jsonl(`${DS}/answer-key.jsonl`).map((one) => [one.id, one]));
const exams = new Map(jsonl(`${DS}/exam-inputs.jsonl`).map((one) => [one.id, one]));

const HAN = /[\u4e00-\u9fff]/u;
const THIN = new Set('的了在是我你他她它们这那就都很也还要会能可以吗呢吧啊么什怎为个和与把被让给对从到说想看去做来去上下里外中得地着过没不'.split(''));
const tokensOf = (text) => {
	const chars = [...String(text ?? '')].filter((ch) => HAN.test(ch));
	const out = [];
	for (let i = 0; i + 1 < chars.length; i++) out.push(`${chars[i]}${chars[i + 1]}`);
	return out;
};
const solid = (token) => [...token].some((ch) => !THIN.has(ch));

const histories = new Map();
const turnsOf = (persona) => {
	if (histories.has(persona)) return histories.get(persona);
	const list = jsonl(`${DS}/${persona}.jsonl`);
	histories.set(persona, list);
	return list;
};

const tally = { direct: 0, direct3: 0, minDf2: 0, feedback: 0, feedbackAny: 0, total: 0 };
const samples = [];

for (const one of misses) {
	const key = keys.get(one.id);
	const exam = exams.get(one.id);
	if (!key || !exam) continue;
	const turns = turnsOf(one.persona).filter((row) => Number(row['轮次']) < exam.cutoff_turn);
	const anchorText = (key.anchors ?? []).map((a) => turns.find((row) => Number(row['轮次']) === Number(a.last_turn))?.['用户消息'] ?? '').join('\n');
	if (anchorText.length === 0) continue;
	/* DF 只数用户轮：检索读的是 l0，但助手的回复与用户的说法同源，差别不影响排序。 */
	const df = new Map();
	for (const row of turns) for (const token of new Set(tokensOf(row['用户消息']))) df.set(token, (df.get(token) ?? 0) + 1);
	const asked = [...new Set(tokensOf(exam.question))].filter(solid);
	const askedSet = new Set(asked);
	const own = new Set(tokensOf(anchorText).filter(solid));
	const shared = asked.filter((token) => own.has(token) && (df.get(token) ?? 0) > 0);
	const ceiling = Math.max(3, Math.round(turns.length * 2 * 3 / 780));
	const rare = (token) => (df.get(token) ?? 0) > 0 && df.get(token) <= ceiling;
	tally.total++;
	/* ① 问句直挑：DF 最稀的两个 */
	const direct = asked.filter(rare).sort((a, b) => df.get(a) - df.get(b));
	if (shared.some((token) => direct.slice(0, 2).includes(token))) tally.direct++;
	if (shared.some((token) => direct.slice(0, 5).includes(token))) tally.direct3++;
	/* ② 直挑但要求 DF ≥ 2 */
	const filtered = direct.filter((token) => df.get(token) >= 2);
	if (shared.some((token) => filtered.slice(0, 2).includes(token))) tally.minDf2++;
	/* ③ 候选行反馈：按共享内容词数取前 10 轮，只留出现在 ≥2 轮里的词 */
	const top = turns
		.map((row) => {
			const mine = new Set(tokensOf(row['用户消息']).filter(solid));
			let n = 0;
			for (const token of mine) if (askedSet.has(token)) n++;
			return { text: row['用户消息'], n };
		})
		.sort((a, b) => b.n - a.n)
		.slice(0, 10)
		.filter((row) => row.n >= 2);
	const docs = new Map();
	for (const row of top) for (const token of new Set(tokensOf(row.text).filter(solid))) if (askedSet.has(token)) docs.set(token, (docs.get(token) ?? 0) + 1);
	const learned = [...docs.entries()].filter(([, seen]) => seen >= 2).map(([token]) => token).filter(rare).sort((a, b) => df.get(a) - df.get(b));
	if (shared.some((token) => learned.slice(0, 2).includes(token))) tally.feedback++;
	if (shared.some((token) => learned.includes(token))) tally.feedbackAny++;
	samples.push({
		id: one.id,
		kind: one.kind,
		direct: direct.slice(0, 2).map((token) => `${token}(${df.get(token)})`).join(' '),
		learned: learned.slice(0, 2).map((token) => `${token}(${df.get(token)})`).join(' '),
		shared: shared.slice(0, 2).map((token) => `${token}(${df.get(token)})`).join(' ')
	});
}

const pct = (n) => `${((n / tally.total) * 100).toFixed(1)}%`;
console.log(`漏检 ${tally.total} 题（kind=${ONLY === '' ? '全部' : ONLY}）· 挑词覆盖「答案共享词」的比例`);
console.log(`  ① 问句直挑，取最稀两个      ${String(tally.direct).padStart(3)}/${tally.total}  = ${pct(tally.direct)}`);
console.log(`     取最稀五个                ${String(tally.direct3).padStart(3)}/${tally.total}  = ${pct(tally.direct3)}`);
console.log(`  ② 直挑 + DF≥2，取最稀两个    ${String(tally.minDf2).padStart(3)}/${tally.total}  = ${pct(tally.minDf2)}`);
console.log(`  ③ 候选行反馈，取最稀两个     ${String(tally.feedback).padStart(3)}/${tally.total}  = ${pct(tally.feedback)}`);
console.log(`     反馈学到的词全算上        ${String(tally.feedbackAny).padStart(3)}/${tally.total}  = ${pct(tally.feedbackAny)}`);
console.log('');
for (const one of samples.slice(0, SHOW)) console.log(`  ${one.id.padEnd(18)} ${one.kind}  直挑=${one.direct.padEnd(16)} 反馈=${one.learned.padEnd(16)} | 答案=${one.shared}`);
