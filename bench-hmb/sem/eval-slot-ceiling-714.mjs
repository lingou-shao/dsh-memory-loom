/*
 * 714 题（六个人物 × 全时点）上，两条「外部成熟方案」的天花板各是多少。
 *
 * 背景：§54.1 量过 142 条未覆盖事实里 135 条死在召回，指针挑选失败 0。所以问题
 * 不是排序，是「那句话压根没进候选池」。外部文献对这件事有两条成熟路线：
 *
 *   A. 槽（attribute-value / key-value memory）——库里已经有 (subject, attr, value)
 *      三列，但只在写侧判冲突用过，读侧从没开过；问句问属性名，证据说值，
 *      两边一个二元组都不相交。
 *   B. 图扩展（HippoRAG 的实体种子 + PPR）——问句和证据共享一个实体（我妈 / 表弟 /
 *      老褚），只是没有共享话题词。把人名当地址做一跳，就能把证据拉进候选池。
 *
 * 这个脚本只读产物，不改产品代码，量的是**天花板**：
 *   - A 的分子：证据里真的有「某对象 = 某值」句式，且问句问的是那个属性
 *   - B 的分子：问句与证据共享一个称呼/人名（不是话题词）
 * 两条都是「理想抽取」，所以是上限，不是可达值。
 *
 * 复跑：node bench-hmb/sem/eval-slot-ceiling-714.mjs
 */
import { readFileSync } from 'node:fs';

const SURFACE = 'C:/Users/shaoz/Desktop/chat-memory-bench/loom-surface.jsonl';
const EVIDENCE = 'C:/Users/shaoz/Desktop/chat-memory-bench/grading/evidence.jsonl';

/** `--quote`：只按原话量，不掺评分标签。量召回用这个。 */
const QUOTE_ONLY = process.argv.includes('--quote');
const surface = readFileSync(SURFACE, 'utf8').trim().split('\n').map(JSON.parse);
const evidence = new Map();
for (const line of readFileSync(EVIDENCE, 'utf8').trim().split('\n')) {
	const row = JSON.parse(line);
	const byId = new Map();
	for (const fact of row.facts ?? []) {
		const quote = (row.sources ?? []).find((s) => s.fact_id === fact.fact_id)?.quote ?? "";
		byId.set(fact.fact_id, { meaning: fact.meaning ?? "", quote, turns: fact.evidence_turns ?? [] });
	}
	evidence.set(row.id, byId);
}

/* 与 lib/index.js 同一个虚字表：只在这里复制一份，是为了不改产品代码也能量。 */
const THIN = new Set([..."怎么什哪几谁啥呀吗呢吧啊嘛的了是在和与就也都还又再只才而且或不没我你他她它们这那个些后前当时今明昨天年月日号点早晚最初先次来"]);
const CJK = /[\u4e00-\u9fff]+/gu;
const bigrams = (text) => {
	const out = [];
	for (const run of String(text).matchAll(CJK)) {
		const chars = [...run[0]];
		for (let i = 0; i < chars.length - 1; i++) out.push(chars[i] + chars[i + 1]);
	}
	return out;
};
const content = (text) => new Set(bigrams(text).filter((b) => ![...b].some((c) => THIN.has(c))));

/* 问句问的是哪个属性。故意只收「问属性名」的问法，不收裸话题。 */
const ATTR_ASK = [
	["职业", /(干什么|干嘛的|做什么工作|做什么的|职业|上班|谋生|在哪工作)/u],
	["城市", /(住哪|住在哪|哪个城市|哪座城|老家|哪儿住)/u],
	["专业", /(什么专业|哪个专业|大学读|读的什么|学历|学什么的)/u],
	["视力", /(视力|近视|远视|散光|戴眼镜|眼睛好不好)/u],
	["姓名", /(全名|名字|叫什么|咋写|怎么写|姓名)/u],
	["生日", /(生日|出生|哪年生的)/u],
	["年龄", /(多大|几岁|岁数|年纪)/u],
	["亲属-属性", /((妈|爸|弟|妹|哥|姐|姥姥|姥爷|奶奶|爷爷|表弟|表妹)[^，。？]{0,6}(生日|工作|爱吃|喜欢|身体|腰|住|做什么))/u]
];

/* 称呼表：这些是「地址」，不是「话题」。命中的二元组算实体锚。 */
const KIN = ["我妈", "我爸", "我弟", "我妹", "我哥", "我姐", "我表弟", "我表妹", "我姥姥", "我姥爷", "我奶奶", "我爷爷", "老公", "老婆", "媳妇", "婆婆"];

/*
 * 别名闭包：同一个人的两种说法。
 *
 * 第一版量 B 的时候只认字面相同的称呼，读数是 0/124——但样本里「我爸」对着
 * 「父亲」、「我姐」对着「姐姐」满地都是。这不是「没有共同实体」，是「共同实体
 * 换了名字」。所以 B 必须按别名闭包量，否则量的是字面而不是机制。
 */
const ALIAS = [
	["父亲", /(我爸|父亲|老爸|爸|爹)/u],
	["母亲", /(我妈|母亲|老妈|妈|娘)/u],
	["兄弟", /(我哥|哥哥|哥|我弟|弟弟|弟)/u],
	["姐妹", /(我姐|姐姐|姐|我妹|妹妹|妹)/u],
	["配偶", /(丈夫|老公|爱人|媳妇|老婆)/u],
	["孩子", /(孩子|女儿|儿子|闺女|米米)/u]
];
const aliasOf = (text) => ALIAS.filter(([, re]) => re.test(text)).map(([name]) => name);

/* 条件 → 做法：偏好与边界题的证据几乎都是这个形状，但问句问的是情景。 */
const CONDITION = /(如果|要是|一到|只有|除非|例外|除[了外]|雨天|阴天|下雪|盘点|出差|周末|工作日|周[一二三四五六日天]|早班|夜班|别|不要|先别|莫|不能)/u;

/*
 * 单字通道：现在的索引只有二元组，`坐很久` 与 `久坐` 一个二元组都不共享，
 * 但共享两个字。Nie 等人 2001 年量过「单字 + 二元组 + 词」的混合索引最好，
 * 我们从 0.1 起就只有二元组。这里量的是：加一条单字通道，上限能捞回多少。
 */
const chars = (text) => new Set([...String(text)].filter((c) => /[\u4e00-\u9fff]/u.test(c) && !THIN.has(c)));

/* 「某对象 = 某值」的句式：是 / 在 / 住 / 读 / 做 / 叫 后面跟一小段值。 */
const SLOT_SHAPE = /(?:是|在|住|读|做|叫|有)[^，。？！\s]{1,10}/u;

const rows = [];
for (const record of surface) {
	const byId = evidence.get(record.id) ?? new Map();
	for (const fact of record.facts ?? []) {
		const covered = (fact.toolR10 ?? 0) >= 0.8;
		const ev = byId.get(fact.factId);
		/*
		* 默认拼 `meaning`（评分标签）+ `quote`（原话），量的上限是「规则认不认
		* 得出这个形状」。**它不能量「库里有没有那句话」**——`meaning` 是标注员
		* 写的（「父亲不吃芹菜」），库里存的只有原话（「芹菜又一口不沾」）。
		* §55.2 的「别名 17/124」就是这么算错的，真实值是 0。
		*
		* 量召回请加 `--quote`，只看原话。见 design §58.1。
		*/
		const text = QUOTE_ONLY ? String(ev?.quote ?? "") : `${ev?.meaning ?? ""} ${ev?.quote ?? ""}`.trim();
		const q = record.question ?? "";
		const shared = [...content(q)].filter((b) => content(text).has(b));
		const asks = ATTR_ASK.filter(([, re]) => re.test(q)).map(([name]) => name);
		const kin = KIN.filter((k) => q.includes(k) && text.includes(k));
		const aliasHit = aliasOf(q).filter((a) => aliasOf(text).includes(a));
		const condition = CONDITION.test(text) && CONDITION.test(q);
		const sharedChars = [...chars(q)].filter((c) => chars(text).has(c));
		rows.push({
			id: record.id,
			tags: record.tags ?? [],
			factId: fact.factId,
			covered,
			shared: shared.length,
			sharedList: shared,
			asks,
			kin,
			aliasHit,
			condition,
			sharedChars: sharedChars.length,
			sharedCharList: sharedChars,
			slotShape: SLOT_SHAPE.test(text),
			text,
			question: q
		});
	}
}

const uncovered = rows.filter((r) => !r.covered);
const byTag = new Map();
for (const r of rows) {
	for (const tag of r.tags) {
		if (!byTag.has(tag)) byTag.set(tag, { all: 0, miss: 0, slot: 0, kin: 0, alias: 0, cond: 0, any: 0 });
		const cell = byTag.get(tag);
		cell.all++;
		if (r.covered) continue;
		cell.miss++;
		const slot = r.asks.length > 0 && r.slotShape;
		if (slot) cell.slot++;
		if (r.kin.length > 0) cell.kin++;
		if (r.aliasHit.length > 0) cell.alias++;
		if (r.condition) cell.cond++;
		if (slot || r.aliasHit.length > 0 || r.condition) cell.any++;
	}
}

const pct = (a, b) => (b === 0 ? "—" : `${a}/${b} = ${(a / b * 100).toFixed(1)}%`);
console.log(`计分事实 ${rows.length} 条，未覆盖 ${uncovered.length} 条\n`);
console.log("考点\t计分\t未覆盖\tA槽\tB别名\tC条件→做法\t并集");
for (const [tag, cell] of [...byTag].sort((a, b) => b[1].miss - a[1].miss)) {
	if (cell.miss === 0) continue;
	console.log(`${tag}\t${cell.all}\t${cell.miss}\t${pct(cell.slot, cell.miss)}\t${pct(cell.alias, cell.miss)}\t${pct(cell.cond, cell.miss)}\t${pct(cell.any, cell.miss)}`);
}

const totals = { slot: 0, alias: 0, cond: 0, any: 0, none: 0 };
for (const r of uncovered) {
	const slot = r.asks.length > 0 && r.slotShape;
	if (slot) totals.slot++;
	if (r.aliasHit.length > 0) totals.alias++;
	if (r.condition) totals.cond++;
	if (slot || r.aliasHit.length > 0 || r.condition) totals.any++;
	else totals.none++;
}
console.log(`\n全卷未覆盖 ${uncovered.length}：A 槽 ${pct(totals.slot, uncovered.length)}｜B 别名闭包 ${pct(totals.alias, uncovered.length)}｜C 条件→做法 ${pct(totals.cond, uncovered.length)}｜三者并 ${pct(totals.any, uncovered.length)}｜都够不着 ${totals.none}`);

const bucket = [0, 0, 0, 0];
for (const r of uncovered) bucket[r.shared >= 3 ? 3 : r.shared]++;
console.log(`\n未覆盖按共享内容二元组：0 个 ${bucket[0]}、1 个 ${bucket[1]}、2 个 ${bucket[2]}、≥3 个 ${bucket[3]}`);

const uni = [0, 0, 0, 0];
for (const r of uncovered) uni[r.sharedChars >= 3 ? 3 : r.sharedChars]++;
console.log(`未覆盖按共享内容**单字**：0 个 ${uni[0]}、1 个 ${uni[1]}、2 个 ${uni[2]}、≥3 个 ${uni[3]}`);
const zeroBigram = uncovered.filter((r) => r.shared === 0);
const zeroBigramChars = zeroBigram.filter((r) => r.sharedChars >= 2).length;
console.log(`二元组 0 个的 ${zeroBigram.length} 条里，单字仍共享 ≥2 个的有 ${pct(zeroBigramChars, zeroBigram.length)}`);
{
	const top = zeroBigram.filter((r) => r.sharedChars >= 2).slice(0, 6);
	for (const r of top) console.log(`  · ${r.question.replace(/\n/g, " / ").slice(0, 34)} ⟷ ${r.text.slice(0, 34)}  【${r.sharedCharList.join("")}】`);
}

const noSlotNoKin = uncovered.filter((r) => !(r.asks.length > 0 && r.slotShape) && r.kin.length === 0);
console.log(`两条都够不着的还有 ${noSlotNoKin.length} 条`);

const top = process.argv.includes('--show') ? Number(process.argv[process.argv.indexOf('--show') + 1] || 12) : 0;
const tagFilter = process.argv.includes('--tag') ? process.argv[process.argv.indexOf('--tag') + 1] : "";
if (top > 0) {
	const pool = tagFilter === "" ? uncovered : uncovered.filter((r) => r.tags.includes(tagFilter));
	for (const r of pool.slice(0, top)) {
		console.log(`\n[${r.id} ${r.tags.join("/")}] 问：${r.question.replace(/\n/g, " / ")}`);
		console.log(`  证据：${r.text.slice(0, 90)}`);
		console.log(`  二元组 ${r.shared}（${r.sharedList.slice(0, 6).join(" ")}）| 单字 ${r.sharedChars}（${r.sharedCharList.slice(0, 8).join("")}）| 槽 ${r.asks.join(",") || "-"} | 别名 ${r.aliasHit.join(",") || "-"}`);
	}
}
