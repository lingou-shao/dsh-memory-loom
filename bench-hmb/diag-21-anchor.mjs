/**
 * 话题链的锚点到底卡在哪（离线，不重跑引擎）。
 *
 * §76.6 记的猜测是「`topicAnchor` 只在前 7 行里挑最晚，真正最晚的那行不在候选里」。
 * 回代码看，这句话有一半是错的：`searchL0(term, cap + 1)` 取 `cap + 1 = 7` 行，
 * 而 DF 超过 `cap = 6` 的词**整条被拒**（`rows.length > cap → return`）。所以
 * 「前 7 行里挑最晚」在 DF ≤ 6 时就是全部行，最晚那行一定在。真正的损失在另一头：
 * **常见词一个都不剩时，锚点是 null，话题链整段不执行**。
 *
 * 这个脚本就把这件事量清楚，顺便量第二处（`TOPIC_SCAN = 8` / `TOPIC_WINDOW = 30 天`）
 * 和第三处（`sharedContent >= 2` 的过滤器）各挡掉多少。
 *
 * 库由 `build-21-db.mjs` 灌好（全量），这里用 `created_at <= now` 切回发问时刻——
 * 依据是 l0 只追加，`text` 永不改写。
 *
 *   node bench-hmb/diag-21-anchor.mjs                      # 全卷
 *   node bench-hmb/diag-21-anchor.mjs --personas M01 --wide 40
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DS = process.env.CMB21_DIR ?? 'C:/Users/shaoz/Desktop/chat-memory-bench/benchmark-2.1/dataset';
const WORK = 'C:/Users/shaoz/Desktop/chat-memory-bench/benchmark-2.1/work';
const OUT = `${WORK}/diag-anchor.json`;
const argOf = (name, fallback) => {
	const i = process.argv.indexOf(`--${name}`);
	return i === -1 ? fallback : process.argv[i + 1];
};
const DB_DIR = argOf('db', path.join(os.tmpdir(), 'loom21'));
const PERSONAS = String(argOf('personas', 'M01,M02')).split(',').filter(Boolean);
/** 常见词还能不能当锚点的上界（`TOPIC_CAP` 之外的第二个上限，见 76.6）。 */
const WIDE = Number(argOf('wide', 40));
/** 不只跑话题链触发的那批题：`--all` 把整个开发集都算一遍（看机制的天花板）。 */
const ALL = process.argv.includes('--all');

const jsonl = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));

/* ==== 与 lib/index.js 同源的几个判据（copy 而不是 import：库是打包单文件） ==== */
const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const LATIN_RUN = /[A-Za-z][A-Za-z0-9_'-]*/g;
const DIGIT_RUN = /\d+(?:[.:-]\d+)*/g;
function tokensOf(text) {
	const tokens = [];
	for (const match of String(text).matchAll(CJK_RUN)) {
		const chars = [...match[0]];
		for (let index = 0; index < chars.length - 1; index++) tokens.push(`${chars[index]}${chars[index + 1]}`);
		if (chars.length === 1) tokens.push(chars[0]);
	}
	for (const match of String(text).matchAll(LATIN_RUN)) tokens.push(match[0].toLowerCase());
	for (const match of String(text).matchAll(DIGIT_RUN)) tokens.push(match[0]);
	return tokens;
}
const THIN_CHARS = new Set([..."怎么什哪几谁啥呀吗呢吧啊嘛的了是在和与就也都还又再只才而且或不没我你他她它们这那个些后前当时今明昨天年月日号点早晚最初先次来"]);
function isThinToken(token) {
	if (/\d/u.test(token) || /[A-Za-z]/u.test(token)) return false;
	if ("我你他她它们".includes(token[0]) && !THIN_CHARS.has(token[1])) return false;
	return [...token].some((char) => THIN_CHARS.has(char));
}
function sharedContent(a, b) {
	let shared = 0;
	for (const token of a) if (b.has(token) && !isThinToken(token)) shared += 1;
	return shared;
}
const QUOTE_FRAME = /^(你之|之前|我之前|前说|前就|就说过|说过|跟我说|跟我讲|当时说|那时说|记得|还记|你说|你讲|跟他说)/u;
function topicPhrase(query) {
	const match = /(?:聊|说|讲|编|关于)([^，。！？；、\s]{2,6}?)(?=时|的时候|的|那|这|，|。|？|！|$)/u.exec(String(query ?? ""));
	return match === null ? null : match[1];
}
const LATER_INTENT = /(后来|之后|以后|最后|最终|结果|到底|交完|完后|成了|办完|弄完|送到|交齐|有没有|进展|还欠|还剩)/u;
const PROGRESS_INTENT = /(?:进行到哪|到哪一步|到哪了|进展|办成|办完|讲完|讲到哪|接着|还算数)/u;
const TOPIC_CAP = 6;
const TOPIC_SCAN = 8;
const TOPIC_WINDOW = 30 * 864e5;
const SETTLE_MAX_CHARS = 140;

const exams = jsonl(path.join(DS, 'exam-inputs.jsonl'));
const keys = new Map(jsonl(path.join(DS, 'answer-key.jsonl')).map((one) => [one.id, one]));
/**
 * 已交付给模型的那几段文本（0.2.56 的取面产物）。
 *
 * 用来回答一个离线诊断必须回答的问题：**这一行是新增的，还是本来就已经在里面**。
 * 只解析 `#L<起>-<止>` 原话指针（行号）；`#E`/`#F` 指向事件与事实，两张表会被
 * 归并重写，全量库上的最终状态回不到发问时刻，这里不碰。
 */
const SURFACE = argOf('surface', `${WORK}/surface-21-later.jsonl`);
const surface = new Map();
if (fs.existsSync(SURFACE)) for (const one of jsonl(SURFACE)) surface.set(one.id, one);

const rows = [];
for (const persona of PERSONAS) {
	const dbPath = path.join(DB_DIR, `${persona}.db`);
	if (!fs.existsSync(dbPath)) {
		console.error(`${persona}: 缺 ${dbPath}，先跑 build-21-db.mjs`);
		continue;
	}
	const db = new DatabaseSync(dbPath, { readOnly: true });
	/*
	* 一次把整个人物的 l0 读进内存（M01 约 6000 行、M02 约 5000 行），
	* 之后每道题只在数组上按时间切片，不再碰数据库。FTS 的 DF 用库里的
	* `l0_fts` 反查——那是产品自己建的索引，口径不会漂。
	*/
	const all = db
		.prepare("SELECT id, session_id, turn, role, text, created_at FROM l0 ORDER BY created_at, id")
		.all()
		.map((row) => ({
			id: Number(row.id),
			sessionId: String(row.session_id),
			turn: Number(row.turn),
			role: String(row.role),
			text: String(row.text),
			createdAt: Number(row.created_at)
		}));
	/** 词的 DF：走产品自己的 FTS 索引（`"term"` 是短语查询，与 `searchL0` 同一写法）。 */
	const IDENT = String(db.prepare('SELECT identity_id FROM l0 LIMIT 1').get()?.identity_id ?? 'master');
	const dfStmt = db.prepare(
		'SELECT count(*) AS n FROM l0_fts JOIN l0 l ON l.id = l0_fts.rowid WHERE l0_fts MATCH ? AND l.identity_id = ? AND l.created_at <= ?'
	);
	const dfOf = (term, now) => {
		try {
			return Number(dfStmt.get(`"${term}"`, IDENT, now).n);
		} catch {
			return 0;
		}
	};

	const mine = exams.filter((one) => one.persona === persona);
	const idTurn = new Map(all.map((one) => [one.id, one.turn]));
	const refsOf = (text) => [...String(text ?? '').matchAll(/#L(\d+)(?:-(\d+))?/gu)].map((m) => [Number(m[1]), Number(m[2] ?? m[1])]);
	/** 已经交给模型的那几段文本覆盖到哪些轮。 */
	const deliveredTurns = (exam) => {
		const row = surface.get(exam.id);
		const turns = new Set();
		if (row === undefined) return turns;
		for (const text of [row.context?.block, row.context?.search, ...(row.context?.expanded ?? []).map((one) => one.text)]) {
			for (const [from, to] of refsOf(text)) {
				for (let id = from; id <= to; id++) {
					const turn = idTurn.get(id);
					if (turn !== undefined) turns.add(turn);
				}
			}
		}
		return turns;
	};
	for (const exam of mine) {
		if (!ALL && !(PROGRESS_INTENT.test(exam.question) || LATER_INTENT.test(exam.question))) continue;
		const now = Date.parse(exam.now);
		const live = all.filter((one) => one.createdAt <= now);
		const answerTurns = new Set((keys.get(exam.id)?.anchors ?? []).map((one) => Number(one.last_turn)));

		/* ---- 候选词与 DF：和 `topicAnchor` 同一个顺序（句法线索优先，再按位置） ---- */
		const cue = topicPhrase(exam.question);
		const seen = new Map();
		const add = (term, rank) => {
			if (isThinToken(term) || QUOTE_FRAME.test(term)) return;
			if (seen.has(term)) return;
			seen.set(term, { term, rank, df: dfOf(term, now) });
		};
		if (cue !== null) {
			const pieces = [...new Set(tokensOf(cue))];
			for (let i = 0; i < pieces.length; i++) add(pieces[i], pieces.length - i);
		}
		const terms = [...new Set(tokensOf(exam.question))];
		for (let i = 0; i < Math.min(24, terms.length); i++) add(terms[i], -i);
		const pool = [...seen.values()].filter((one) => one.df > 0);
		const pickAnchor = (list) =>
			list.reduce(
				(best, one) => (best === null || one.df < best.df || (one.df === best.df && one.rank > best.rank) ? one : best),
				null
			);
		const rare = pool.filter((one) => one.df <= TOPIC_CAP);
		const product = pickAnchor(rare);
		const widePool = pool.filter((one) => one.df > TOPIC_CAP && one.df <= WIDE);
		const wide = pickAnchor(widePool);

		/** 某个词在发问时刻之前的最后一次出现。 */
		const lastOf = (term) => {
			const hits = live.filter((one) => tokensOf(one.text).includes(term));
			return hits.length === 0 ? null : hits[hits.length - 1];
		};
		/** `turnsAfter` + 三道过滤（时间窗 / 长度 / 共享实词）。 */
		const followOf = (mention, withShared) => {
			const own = new Set(tokensOf(mention.text).filter((token) => !isThinToken(token)));
			const after = [];
			const byTurn = new Map();
			for (const one of live) {
				if (one.sessionId !== mention.sessionId || one.role !== "user" || one.turn <= mention.turn) continue;
				const seat = byTurn.get(one.turn);
				if (seat === undefined) byTurn.set(one.turn, one);
			}
			for (const one of [...byTurn.values()].sort((a, b) => a.turn - b.turn).slice(0, TOPIC_SCAN)) after.push(one);
			return after.map((one) => ({
				turn: one.turn,
				at: one.createdAt,
				text: one.text,
				inWindow: one.createdAt - mention.createdAt <= TOPIC_WINDOW,
				short: one.text.length <= SETTLE_MAX_CHARS,
				shared: sharedContent(own, new Set(tokensOf(one.text))),
				pass: one.createdAt - mention.createdAt <= TOPIC_WINDOW && one.text.length <= SETTLE_MAX_CHARS && (!withShared || sharedContent(own, new Set(tokensOf(one.text))) >= 2)
			}));
		};

		const describe = (anchor) => {
			if (anchor === null) return { term: null };
			const mention = lastOf(anchor.term);
			if (mention === null) return { term: anchor.term, df: anchor.df, mention: null };
			const follow = followOf(mention, true);
			const loose = followOf(mention, false);
			const next = follow.filter((one) => one.pass).at(-1) ?? null;
			const pick = next ?? (mention.role === "user" ? mention : null);
			return {
				term: anchor.term,
				df: anchor.df,
				mention: { turn: mention.turn, at: mention.createdAt, text: mention.text.slice(0, 40) },
				follow: follow.map((one) => ({ turn: one.turn, pass: one.pass, shared: one.shared, inWindow: one.inWindow, short: one.short })),
				looseTurns: loose.map((one) => one.turn),
				pickTurn: pick === null ? null : pick.turn,
				hit: pick !== null && answerTurns.has(pick.turn),
				/** 答案轮在 mention 之后多少轮 / 多少天；不在后面就是 null。 */
				gap:
					answerTurns.size === 0
						? null
						: [...answerTurns]
								.map((turn) => {
									const row = live.find((one) => one.turn === turn && one.sessionId === mention.sessionId);
									return row === undefined ? null : { turn: turn - mention.turn, days: (row.createdAt - mention.createdAt) / 864e5 };
								})
								.filter(Boolean)
								.sort((a, b) => a.turn - b.turn)[0] ?? null
			};
		};

		/*
		* 变体：不挑「最稀有的那一个二元组」，改按「和整句问句的重叠」挑行。
		*
		* 动机是上面那张逐题表：产品锚点大量是跨词边界的碎片（「我之」「爸问」「式有」
		* 「底多」），DF 只有 1–3，靠「最稀有」赢下比赛，却不指向任何话题。而一个真正
		* 在谈这个话题的句子，不会只碰上一个二元组——它会把问句里好几个内容词一起碰上。
		*/
		const qwords = new Set([...new Set(tokensOf(exam.question))].filter((token) => !isThinToken(token) && !QUOTE_FRAME.test(token)));
		const overlapOf = (text) => sharedContent(qwords, new Set(tokensOf(text)));
		const userTurns = live.filter((one) => one.role === "user");
		const withOverlap = userTurns.map((one) => ({ row: one, weight: overlapOf(one.text) }));
		const atLeast = (k) => withOverlap.filter((one) => one.weight >= k);
		/**
		* 一条原话里，与问句共享的那些词从第一个到最后一个跨多远（字符数）。
		*
		* 外部材料说「词距 > 100 就降权、< 20 就加分」，用来杀「A 在开头 B 在结尾」的
		* 伪命中。能不能用，取决于**真答案**的跨度分布——如果正确答案本身就把两个词
		* 分在句子两头，这条规则会先把真答案杀掉。
		*/
		const spanOf = (text) => {
			let start = Infinity;
			let end = -1;
			for (const token of qwords) {
				const at = text.indexOf(token);
				if (at === -1) continue;
				start = Math.min(start, at);
				end = Math.max(end, at + token.length);
			}
			return end < 0 ? null : end - start;
		};
		/** 一条规则的产物：最多 `want` 轮，直接当指针用。 */
		const delivered = deliveredTurns(exam);
		const alreadyCovered = [...answerTurns].some((turn) => delivered.has(turn));
		const seeded = delivered.size === 0 ? 0 : Math.max(...delivered);
		/** 池子超过 `threshold` 行就要求共享 ≥3 个实词，否则维持 ≥2（外部材料的「防爆阀门」）。 */
		const adaptive = (threshold) => atLeast(atLeast(2).length >= threshold ? 3 : 2).slice(-3).map((one) => one.row);
		/*
		* §80：外部材料把「挑哪几行」写成 0-1 背包。公式不用抄，能落地的只有一句话：
		* **别按「最新」挑，按分数挑**。这里把它的几种写法并排量一遍。
		*
		* 先钉一个前提：进块的行每条都被 `clip(rawPreview = 60)` 截过，所以每条
		* 重量相同（≤60 字符），背包退化成「取前 k 条」——200 字符预算恰好就是
		* 3 条。变长只发生在短行上，所以 `packNewest` 允许最多 6 条短行挤进 200。
		*/
		const poolRows = atLeast(2);
		const charsOf = (one) => Math.min(one.row.text.length, 60);
		const byWeight = (a, b) => b.weight - a.weight || b.row.turn - a.row.turn;
		const byDensity = (a, b) => b.weight / Math.max(1, charsOf(b)) - a.weight / Math.max(1, charsOf(a)) || b.row.turn - a.row.turn;
		const asc = (list) => [...list].sort((a, b) => a.row.turn - b.row.turn).map((one) => one.row);
		/** 200 字符预算，从最新往回装（材料给的硬上限）。 */
		const packNewest = (list, budget) => {
			const out = [];
			let used = 0;
			for (let i = list.length - 1; i >= 0 && out.length < 6; i--) {
				const cost = charsOf(list[i]);
				if (used + cost > budget) continue;
				used += cost;
				out.push(list[i]);
			}
			return asc(out);
		};
		/** 按某个顺序装包。 */
		const packBy = (list, cmp, budget) => {
			const out = [];
			let used = 0;
			for (const one of [...list].sort(cmp)) {
				if (out.length >= 6) break;
				const cost = charsOf(one);
				if (used + cost > budget) continue;
				used += cost;
				out.push(one);
			}
			return asc(out);
		};
		/** 边际增益贪心：每步取「重叠 − 与已选的重复」（材料第 4 条 COMI 的朴素版）。 */
		const marginal = (list, want) => {
			const picked = [];
			const left = [...list];
			const sets = new Map(left.map((one) => [one.row.id, new Set(tokensOf(one.row.text))]));
			while (picked.length < want && left.length > 0) {
				let bestAt = 0;
				let bestScore = -Infinity;
				for (let i = 0; i < left.length; i++) {
					const own = sets.get(left[i].row.id);
					let overlap = 0;
					for (const one of picked) overlap += sharedContent(own, one.set);
					const score = left[i].weight - overlap;
					if (score > bestScore || (score === bestScore && left[i].row.turn > left[bestAt].row.turn)) {
						bestScore = score;
						bestAt = i;
					}
				}
				const take = left.splice(bestAt, 1)[0];
				picked.push({ row: take.row, turn: take.row.turn, set: sets.get(take.row.id) });
			}
			return asc(picked);
		};
		/** 连通分量抽样（材料「拓扑 / Betti-0」那条）：两行共享 ≥2 实词就连一条边，每簇取最新一条。 */
		const components = (list, want) => {
			const n = list.length;
			const parent = Array.from({ length: n }, (_, i) => i);
			const find = (i) => {
				while (parent[i] !== i) {
					parent[i] = parent[parent[i]];
					i = parent[i];
				}
				return i;
			};
			const sets = list.map((one) => new Set(tokensOf(one.row.text)));
			for (let i = 0; i < n; i++) {
				for (let j = i + 1; j < n; j++) {
					if (sharedContent(sets[i], sets[j]) < 2) continue;
					const a = find(i);
					const b = find(j);
					if (a !== b) parent[a] = b;
				}
			}
			const groups = new Map();
			list.forEach((one, i) => {
				const root = find(i);
				const arr = groups.get(root) ?? [];
				arr.push(one);
				groups.set(root, arr);
			});
			const reps = [...groups.values()].map((arr) => arr[arr.length - 1]).sort((a, b) => b.row.turn - a.row.turn).slice(0, want);
			const have = new Set(reps.map((one) => one.row.id));
			for (const one of [...list].reverse()) {
				if (reps.length >= want) break;
				if (have.has(one.row.id)) continue;
				have.add(one.row.id);
				reps.push(one);
			}
			return asc(reps);
		};
		const rules = {
			/** 按分数取前 3——这就是材料那个「贪心背包」在等重条件下的结果。 */
			w3: () => asc([...poolRows].sort(byWeight).slice(0, 3)),
			w5: () => asc([...poolRows].sort(byWeight).slice(0, 5)),
			/** 密度分（Qwen「密度感知压缩比」）：重叠词数 / 字符数。 */
			dens3: () => asc([...poolRows].sort(byDensity).slice(0, 3)),
			marg3: () => marginal(poolRows, 3),
			comp3: () => components(poolRows, 3),
			/** 200 字符预算的三种装法。 */
			budget200: () => packNewest(poolRows, 200),
			w3pack: () => packBy(poolRows, byWeight, 200),
			densPack: () => packBy(poolRows, byDensity, 200),
			/**
			* 池子大才多给两条（§80.4）。
			*
			* 上面那张表的形状是两套库完全不同的：M01 池子中位 2 行，任何判据的真增量
			* 都是 10 题、一动不动的 2.15 行；M02 池子中位 53 行，判据换不动，**只有
			* 加条数动得了**（3 条 7 题 → 5 条 9 题）。所以条数不该是常数，池子大到
			* 分不清时多给两条，池子小的时候维持原样不花字符。
			*/
			pool5: () => (poolRows.length >= 20 ? poolRows.slice(-5) : poolRows.slice(-3)).map((one) => one.row),
			/** 最近一次重叠 ≥2 / ≥3 的轮，再往后再走 8 轮（与产品的链同一套走法）。 */
			q2: () => (atLeast(2).length ? [atLeast(2).at(-1).row] : []),
			q3: () => (atLeast(3).length ? [atLeast(3).at(-1).row] : []),
			/** 最后 3 / 5 个重叠 ≥2 的轮——想问「一次不够，多给几条」值不值。 */
			q2tail3: () => atLeast(2).slice(-3).map((one) => one.row),
			q2tail5: () => atLeast(2).slice(-5).map((one) => one.row),
			/** 重叠最大的那一轮（并列取更晚的）。 */
			qmax: () => {
				const best = atLeast(2).reduce((top, one) => (top === null || one.weight >= top.weight ? one : top), null);
				return best === null ? [] : [best.row];
			},
			/**
			* 加了闸门：只在「已经交付出去的最后一轮之后」找。
			*
			* §76.3 量到 79 道未命中题里 48 道（60.8%）手上全是答案轮**之前**的条目。
			* 那条现象本身就是这条规则的准入：手上已经有更晚的说法时，不需要再补；
			* 手上全是早的，就去后面找最像在谈这件事的一轮。
			*/
			qmaxAfter: () => {
				const pool = atLeast(2).filter((one) => one.row.turn > seeded);
				const best = pool.reduce((top, one) => (top === null || one.weight >= top.weight ? one : top), null);
				return best === null ? [] : [best.row];
			},
			/**
			* 自适应门限：候选池大就要更高的重叠。
			*
			* 外部材料提的那条「防爆阀门」——池子大了说明问句本身泛（「今天」「早上」），
			* 此时共享 2 个词几乎是偶然。这里按三个阈值各跑一遍，看它到底拦住了什么。
			*/
			adapt5: () => adaptive(5),
			adapt10: () => adaptive(10),
			adapt20: () => adaptive(20),
			/**
			* 词距当硬过滤：跨度超过上限的行直接不要，再从池子里往前补三行。
			*
			* 这是外部材料第 3 条的严格实现（「>100 字符降权或丢弃、<20 加分」）。
			* 只测丢弃那一半——「加分」是重排，重排在 §73 已经量过是零和的。
			*/
			span100: () => atLeast(2).filter((one) => (spanOf(one.row.text) ?? 0) <= 100).slice(-3).map((one) => one.row),
			span40: () => atLeast(2).filter((one) => (spanOf(one.row.text) ?? 0) <= 40).slice(-3).map((one) => one.row),
			span20: () => atLeast(2).filter((one) => (spanOf(one.row.text) ?? 0) <= 20).slice(-3).map((one) => one.row),
			/**
			* 把「自适应」用在词距上，而不是用在重叠门槛上。
			*
			* 上面那张表给出的形状：池子小的库（M01，中位 3 行）里过滤词距只掉不掉；
			* 池子大的库（M02，中位 51 行）里过滤词距 +1/+3。所以自适应该管的不是
			* 「要不要提高门槛」，而是「要不要按词距筛」。
			*/
			mix20: () => (atLeast(2).length >= 20
				? atLeast(2).filter((one) => (spanOf(one.row.text) ?? 0) <= 40).slice(-3)
				: atLeast(2).slice(-3)).map((one) => one.row)
		};
		const runRule = (name) => {
			const seeds = rules[name]();
			if (seeds.length === 0) return { name, seeds: [], hit: false, hitByFollow: false, follow: false };
			const turns = seeds.map((one) => one.turn);
			/** 直取：答案轮就在这几条里。 */
			const hit = turns.some((turn) => answerTurns.has(turn));
			/** 链式：从**最晚**那条往后走 8 轮（产品的走法），落在答案轮上。 */
			const last = seeds.at(-1);
			const follow = followOf(last, true);
			const next = follow.filter((one) => one.pass).at(-1) ?? null;
			const hitByFollow = (next !== null && answerTurns.has(next.turn)) || answerTurns.has(last.turn);
			return {
				name,
				seeds: turns,
				weights: seeds.map((one) => overlapOf(one.text)),
				hit,
				hitByFollow,
				follow: true
			};
		};

		rows.push({
			id: exam.id,
			persona,
			query: exam.question,
			chain: { progress: PROGRESS_INTENT.test(exam.question), later: LATER_INTENT.test(exam.question) },
			answerTurns: [...answerTurns],
			poolSize: pool.length,
			minDf: pool.length === 0 ? null : Math.min(...pool.map((one) => one.df)),
			product: describe(product),
			wide: describe(wide),
			rules: Object.fromEntries(Object.keys(rules).map((name) => [name, runRule(name)])),
			/** 答案轮自身与问句的重叠——这是任何「按重叠挑行」方案的天花板。 */
			answerWeights: [...answerTurns].map((turn) => {
				const row = live.find((one) => one.turn === turn);
				return row === undefined ? 0 : overlapOf(row.text);
			}),
			topicRows: atLeast(2).length,
			/** 话题链实际会追加的那三行：命中/未命中各是什么跨度——词距判据有没有区分力。 */
			tailRows: atLeast(2).slice(-3).map((one) => ({
				turn: one.row.turn,
				hit: answerTurns.has(one.row.turn),
				weight: one.weight,
				span: spanOf(one.row.text),
				length: one.row.text.length
			})),
			/** 答案轮自己的跨度：词距判据能留住的真答案占多少。 */
			answerSpans: [...answerTurns]
				.map((turn) => live.find((one) => one.turn === turn))
				.filter((one) => one !== void 0)
				.map((one) => ({ span: spanOf(one.text), weight: overlapOf(one.text), length: one.text.length })),
			/** 这一题的答案轮是否已经由 0.2.56 的产物交付（增量分析的分母）。 */
			alreadyCovered,
			seeded,
			noAnchor: product === null,
			noWide: wide === null
		});
	}
	db.close();
	console.error(`${persona} 完成：${rows.filter((one) => one.persona === persona).length} 道话题链题`);
}

const pct = (n, d) => (d === 0 ? '—' : `${((100 * n) / d).toFixed(1)}%`);

/** 一组题上的规则对比（`--all` 时按「触发 / 不触发」分组各打一遍）。 */
function report(label, list) {
	if (list.length === 0) return;
	const ceil = (k) => list.filter((one) => Math.max(0, ...one.answerWeights) >= k).length;
	console.log(`\n--- ${label}：${list.length} 题 ---`);
	console.log(`  产品锚点命中答案轮 ${list.filter((one) => one.product.hit).length}（${pct(list.filter((one) => one.product.hit).length, list.length)}）`);
	for (const name of ['q2', 'q3', 'pool5', 'q2tail3', 'q2tail5', 'qmax', 'qmaxAfter', 'adapt5', 'adapt10', 'adapt20', 'span100', 'span40', 'span20', 'mix20', 'w3', 'w5', 'dens3', 'marg3', 'comp3', 'budget200', 'w3pack', 'densPack']) {
		const direct = list.filter((one) => one.rules[name].hit).length;
		console.log(`  规则 ${name.padEnd(9)} 直取答案轮 ${String(direct).padStart(3)}（${pct(direct, list.length)}）`);
	}
	const uncovered = list.filter((one) => !one.alreadyCovered);
	console.log(
		`  增量（只在未交付的 ${uncovered.length} 题里数）：` +
			['q2tail3', 'adapt10', 'span40', 'mix20']
				.map((name) => `${name} +${uncovered.filter((one) => one.rules[name].hit).length}`)
				.join('  ')
	);
	/*
	* 增量口径：只在**现在还没交付到答案轮**的题上数，且只认 0.2.56 产物里
	* 那份文本没覆盖过的。这是这条规则真正能加的东西——其余命中都已经是重复。
	*/
	const gain = (name) => uncovered.filter((one) => one.rules[name].hit).length;
	console.log(
		`  当前已交付答案轮 ${list.length - uncovered.length}/${list.length}（${pct(list.length - uncovered.length, list.length)}）；` +
			`未交付 ${uncovered.length} 题里，qmax 能补 ${gain('qmax')}、qmaxAfter 能补 ${gain('qmaxAfter')}`
	);
	console.log(`  天花板（答案轮自身重叠 ≥2）${ceil(2)}（${pct(ceil(2), list.length)}）、≥3 的 ${ceil(3)}`);
	/** 候选噪音：每题有多少轮与问句重叠 ≥2 —— 判「按重叠挑行」会不会淹没在闲聊里。 */
	const counts = list.map((one) => one.topicRows).sort((a, b) => a - b);
	console.log(`  每题「重叠 ≥2」的轮数：中位 ${counts[counts.length >> 1]}、上四分位 ${counts[(3 * counts.length) >> 2]}、最多 ${counts.at(-1)}`);

	/* 词距：真答案 vs 旁路实际交出去的行，跨度分布差多少。 */
	const spans = (rows) => rows.map((one) => one.span).filter((one) => one !== null).sort((a, b) => a - b);
	const med = (arr) => (arr.length === 0 ? '—' : arr[arr.length >> 1]);
	const tails = list.flatMap((one) => one.tailRows);
	const hitSpans = spans(tails.filter((one) => one.hit));
	const missSpans = spans(tails.filter((one) => !one.hit));
	const ansSpans = spans(list.flatMap((one) => one.answerSpans));
	console.log(
		`  词距（共享词首尾跨度，字符）：答案轮中位 ${med(ansSpans)}（n=${ansSpans.length}）；` +
			`旁路行命中中位 ${med(hitSpans)}（n=${hitSpans.length}）、未命中中位 ${med(missSpans)}（n=${missSpans.length}）`
	);
	const over = (arr, n) => `${arr.filter((one) => one > n).length}/${arr.length}`;
	console.log(
		`  跨度 >20 的比例：答案轮 ${over(ansSpans, 20)}、命中行 ${over(hitSpans, 20)}、未命中行 ${over(missSpans, 20)}；` +
			`>100 的比例：答案轮 ${over(ansSpans, 100)}、命中行 ${over(hitSpans, 100)}、未命中行 ${over(missSpans, 100)}`
	);
}

for (const persona of [...new Set(rows.map((one) => one.persona))]) {
	const list = rows.filter((one) => one.persona === persona);
	const noAnchor = list.filter((one) => one.noAnchor);
	const hitNow = list.filter((one) => one.product.hit);
	const hitWide = list.filter((one) => one.product.hit || one.wide.hit);
	console.log(`\n=== ${persona}：${ALL ? '全开发集' : '话题链触发'} ${list.length} 题 ===`);
	console.log(`  DF ≤ ${TOPIC_CAP} 的词一个都没有（无锚点）：${noAnchor.length}（${pct(noAnchor.length, list.length)}）`);
	console.log(`  有锚点 ${list.length - noAnchor.length} 题，其中补的那条命中答案轮：${hitNow.length}（${pct(hitNow.length, list.length)}）`);
	const wideHit = list.filter((one) => !one.product.hit && one.wide.hit);
	console.log(`  常见词兜底（DF ${TOPIC_CAP + 1}–${WIDE}，取最后一次出现）额外命中：${wideHit.length} → 合计 ${hitWide.length}（${pct(hitWide.length, list.length)}）`);
	console.log(`  无兜底可用（连 DF ≤ ${WIDE} 的词都没有）：${list.filter((one) => one.noWide).length}`);

	const gaps = list.map((one) => one.product.gap).filter(Boolean);
	const after = gaps.filter((one) => one.turn > 0);
	console.log(
		`  答案轮在锚点之后：${after.length}/${gaps.length}；轮距中位 ` +
			`${after.length ? [...after].sort((a, b) => a.turn - b.turn)[after.length >> 1].turn : '—'}，` +
			`日期距中位 ${after.length ? [...after].sort((a, b) => a.days - b.days)[after.length >> 1].days.toFixed(0) + ' 天' : '—'}`
	);
	const within8 = after.filter((one) => one.turn <= TOPIC_SCAN && one.days <= 30).length;
	const within8Long = after.filter((one) => one.turn <= TOPIC_SCAN).length;
	console.log(`  同时满足「≤${TOPIC_SCAN} 轮」和「≤30 天」：${within8}；只满足轮距：${within8Long}`);

	if (ALL) {
		report('话题链触发', list.filter((one) => one.chain.progress || one.chain.later));
		report('不触发', list.filter((one) => !one.chain.progress && !one.chain.later));
	} else {
		report('全部', list);
	}

	console.log(`  逐题（只列没命中且有兜底的）`);
	for (const one of list.filter((row) => !row.product.hit && row.wide.term)) {
		const w = one.wide;
		console.log(
			`    ${one.id.padEnd(16)} 产品锚点 ${String(one.product.term ?? '—').padEnd(4)} DF ${String(one.product.df ?? '—').padStart(3)}` +
				` | 兜底 ${String(w.term).padEnd(4)} DF ${String(w.df).padStart(3)} 取第 ${w.pickTurn ?? '—'} 轮` +
				` | 答案 ${one.answerTurns.join(',') || '—'} | gap ${w.gap ? `${w.gap.turn}轮/${w.gap.days.toFixed(0)}天` : '—'}`
		);
	}
}
fs.writeFileSync(OUT, JSON.stringify({ wide: WIDE, rows }, null, 1), 'utf8');
console.log(`\n写 ${OUT}`);
