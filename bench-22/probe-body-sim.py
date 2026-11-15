# -*- coding: utf-8 -*-
"""`events.body` 值不值得改产品：在 FTS5 上做一次离线模拟，不动 `lib/`。

§119.2 定的是「加一列 body 存整轮原文、进 events_fts、权重 0.5，渲染仍只读
title/summary」。改之前有两个问题必须先回答，否则就是先付钱后看货：

  1. **字面够不够**：`probe-body-input.py` 量到摘要只覆盖原文二元组的 21.4%，
     而问句里「摘要没有、原文有」的 token 每题中位 21 个、落在证据行上的中位 3 个。
     3 个新命中能不能把一行推进前 10？这是这个脚本要回答的。
  2. **长度归一化会不会整体漂移**：FTS5 的 `k1`/`b` 是硬编码（1.2 / 0.75），
     `|D|` 与 `avgdl` 都是**整行**级（官方文档 5.1.1），列权重只改 `f(qi,D)`。
     所以加一列会把每一行的分数都挪一下，不只是命中 body 的行。

做法：每题按截止轮建两个**内存** FTS5 表，塞进当时可见的全部事件行，

    simA  tokens, title, summary             ← 现状（events_fts 的三列）
    simB  tokens, title, summary, body       ← 加 body，权重 0.5，body 是整轮原文的二元组

同一个 MATCH（放宽趟的 OR 表达式）、同样的 bm25 权重（5/1/1/0.5），比证据行能不能进前 10。

    python bench-22/probe-body-sim.py --db bench-22/work/db/M02-5413.db --persona M02
"""

import argparse
import json
import os
import re
import sqlite3
import statistics
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get("BENCH22_DATA") or os.path.join(
	os.path.expanduser("~"), "Desktop", "cmb-2.2", "benchmark-2.2", "dataset"
)

CJK_RUN = re.compile(r"[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+")
LATIN_RUN = re.compile(r"[A-Za-z][A-Za-z0-9_]+")
DIGIT_RUN = re.compile(r"[0-9]+")
THIN = set("怎么什哪几谁啥呀吗呢吧啊嘛的了是在和与就也都还又再只才而且或不没我你他她它们这那个些后前当时今明昨天年月日号点早晚最初先次来")


def tokens_of(text):
	out = []
	for run in CJK_RUN.findall(text or ""):
		chars = list(run)
		for i in range(len(chars) - 1):
			out.append(chars[i] + chars[i + 1])
		if len(chars) == 1:
			out.append(chars[0])
	for run in LATIN_RUN.findall(text or ""):
		out.append(run.lower())
	for run in DIGIT_RUN.findall(text or ""):
		out.append(run)
	return out


def loose_match(query, limit=12, content_only=False):
	all_tokens = list(dict.fromkeys(tokens_of(query)))
	unique = [t for t in all_tokens if not content_only or not any(c in THIN for c in t)][:limit]
	if not unique:
		return None
	return " OR ".join('"%s"' % t.replace('"', '""') for t in unique)


def jl(path):
	with open(path, encoding="utf-8") as fh:
		for line in fh:
			if line.strip():
				yield json.loads(line)


def rank_of(sim, expr, table, weights):
	"""返回 {rowid: rank}（1 起），只算前 50。"""
	rows = sim.execute(
		f"SELECT rowid, bm25({table}, {weights}) AS s FROM {table} WHERE {table} MATCH ? ORDER BY s LIMIT 50",
		(expr,),
	).fetchall()
	return {r[0]: i + 1 for i, r in enumerate(rows)}


def main():
	ap = argparse.ArgumentParser()
	ap.add_argument("--db", required=True)
	ap.add_argument("--persona", default="M02")
	ap.add_argument("--ctx", default=os.path.join(HERE, "work", "ctx-0279"))
	ap.add_argument("--topk", type=int, default=10)
	ap.add_argument("--weight", type=float, default=0.5, help="body 列的 bm25 权重")
	ap.add_argument("--weights", default="", help="扫多个权重，逗号分隔，例如 0.2,0.3,0.5,1.0")
	ap.add_argument("--append", action="store_true", help="也量「body 单独一张表、只做追加档」的方案")
	ap.add_argument("--limit", type=int, default=0)
	ap.add_argument("--dump-dropped", default="", help="把「闸门后证据行一个不剩」的题 id 写到这个文件")
	ap.add_argument("--gate", type=float, default=0.0, help="只保留过得了这个 containment 闸门的行（产品的 relaxMinOverlap=0.05）")
	ap.add_argument("--gate-body", action="store_true", help="闸门的 haystack 也带上原文（判据一起改）")
	ap.add_argument("--gate-adaptive", type=float, default=0.0,
		help="只对「摘要/原文 token 比低于这个值」的行把原文并进闸门（按行分层的判据）")
	ap.add_argument("--shuffle-body", action="store_true",
		help="把每行的 body 词表随机置换。**这个对照是无效的**：bm25 是 bag-of-words，顺序不影响分数，留在这是为了钉住这一点")
	ap.add_argument("--noise-body", action="store_true",
		help="body 换成从全库词表随机抽出的等长 token 序列：把「行长」和「内容」分开")
	ap.add_argument("--two-stage", action="store_true",
		help="两阶段：body 只用来召回（决定谁进候选），排序仍用三列分数")
	args = ap.parse_args()

	db = sqlite3.connect(args.db)
	db.row_factory = sqlite3.Row
	events = db.execute("SELECT id, title, summary, tokens, l0_from, l0_to, turn_to FROM events").fetchall()
	l0 = {r["id"]: r for r in db.execute("SELECT id, turn, tokens FROM l0")}

	VOCAB = sorted({t for row in l0.values() for t in row["tokens"].split()})
	# 事件 → (整轮原文的二元组, 含哪些轮次)
	body_of, turns_of = {}, {}
	for ev in events:
		parts, turns = [], set()
		for rid in range(ev["l0_from"], ev["l0_to"] + 1):
			row = l0.get(rid)
			if row is not None:
				parts.append(row["tokens"])
				turns.add(row["turn"])
		body_of[ev["id"]] = " ".join(parts)
		turns_of[ev["id"]] = turns

	cuts = {r["id"]: r["cutoff_turn"] for r in jl(os.path.join(args.ctx, args.persona, "contexts.jsonl"))}
	keys = {r["id"]: [int(t) for t in (r.get("evidence_turns") or [])] for r in jl(os.path.join(DATA, "review-only", "answer-key.jsonl"))}
	items = [r for r in jl(os.path.join(DATA, "exam-inputs.jsonl")) if r.get("persona") == args.persona]

	dropped = []
	W = args.weight
	WEIGHTS = [float(x) for x in args.weights.split(",")] if args.weights else [W]
	KEYS = ["2stage"] if args.two_stage else WEIGHTS
	out = []
	for item in items:
		sid = item["id"]
		if sid not in cuts or not keys.get(sid):
			continue
		cut, ev_turns = cuts[sid], set(keys[sid])
		expr = loose_match(item["question"])
		if expr is None:
			continue
		avail = [ev for ev in events if ev["turn_to"] <= cut]
		if args.gate > 0:
			"""
			产品的放宽趟带一道 containment 闸门：问句二元组在**渲染文本**
			（title：summary）里的覆盖率低于 relaxMinOverlap 就进 tailRows，
			满员时直接丢。这里把它套上，是为了看「只加 FTS 列、不动判据」
			时增益还剩多少——判据看不见 body，是这一版最容易漏掉的一层。
			"""
			qtok = set(tokens_of(item["question"]))
			keep = []
			for ev in avail:
				stok = set(tokens_of(ev["title"] + " " + ev["summary"]))
				hay = set(stok)
				if args.gate_body:
					hay |= set(body_of[ev["id"]].split())
				elif args.gate_adaptive > 0:
					"""
					按行分层：摘要压得越狠，越信原文。

					M01 的摘要中位覆盖原文 0.62、M02 只有 0.23——两个 persona 的差别
					不在「问句长短」，在「摘要是不是被改写过」。一个写死的阈值在这
					里不是拍脑袋的常数，它量的是**这一行自己的压缩率**（相对量）。
					"""
					btok = set(body_of[ev["id"]].split())
					if btok and len(stok) / len(btok) < args.gate_adaptive:
						hay |= btok
				if qtok and len(qtok & hay) / len(qtok) >= args.gate:
					keep.append(ev)
			avail = keep
		# 只看「含证据轮」的那些行——它们才是覆盖率的分母
		gold = [ev["id"] for ev in avail if turns_of[ev["id"]] & ev_turns]
		if not gold:
			"""
			闸门把这条证据行挡掉了：`containment(query, 摘要) < gate`，它进不了
			候选池。这批题就是「判据读渲染文本」的代价，单独记下来——它们的
			覆盖率由原话通道兜，兜不兜得住是另一件事。
			"""
			dropped.append(sid)
			continue

		"""
		两张表，不是一张表加零权重。

		FTS5 的 `|D|` 与 `avgdl` 是**整行**级（官方 5.1.1），列权重只改 `f(qi,D)`。
		所以 `bm25(sim, 5,1,1, 0.0)` 里的 0 只把该列的 tf 归零，那一列的 token
		仍然算进 |D|——「权重 0」不等于「没有这一列」，两者的 avgdl 不一样。
		基线必须是**三列表**，也就是现在 `events_fts` 的样子。
		"""
		sim = sqlite3.connect(":memory:")
		sim.execute("CREATE VIRTUAL TABLE a USING fts5(tokens, title, summary)")
		sim.execute("CREATE VIRTUAL TABLE b USING fts5(tokens, title, summary, body)")
		rows_in = []
		rng = __import__("random").Random(20261115)
		for ev in avail:
			btok = body_of[ev["id"]].split()
			if args.noise_body:
				"""
				等长、但词是随机抽的。

				`--shuffle-body` 那个对照在这里是无效的：bm25 只数词频，不看顺序，
				打乱一个 bag 还是同一个 bag。要分开「行长」和「内容」，只能换词。
				词表就取这个库自己的 l0 token 全集——分布相同，只破坏「这一轮在
				说什么」。
				"""
				btok = [VOCAB[rng.randrange(len(VOCAB))] for _ in range(len(btok))]
			elif args.shuffle_body:
				"""
				同一批词、同样的行长，只是把词序打乱。

				|D| 与 avgdl 一个字节都没变，所以分数变化只能来自「内容」——
				这是把长度归一化的漂移与字面命中这两件事分开的唯一办法。
				"""
				btok = btok[:]
				rng.shuffle(btok)
			rows_in.append((ev["id"], ev["tokens"], ev["title"], ev["summary"], " ".join(btok)))
		sim.executemany("INSERT INTO a (rowid, tokens, title, summary) VALUES (?,?,?,?)",
			[(r[0], r[1], r[2], r[3]) for r in rows_in])
		sim.executemany("INSERT INTO b (rowid, tokens, title, summary, body) VALUES (?,?,?,?,?)", rows_in)
		rankA = rank_of(sim, expr, "a", "5.0, 1.0, 1.0")
		ranks = {}
		if args.two_stage:
			"""
			两阶段：`b` 决定**谁进候选**（body 的字面在这里起作用），
			`a` 决定**怎么排**（分数完全来自 title/summary 的索引）。

			这是 doc2query 一类系统的标准做法——扩展文本只扩召回，不参与打分。
			好处是 avgdl 与 |D| 一个字节都没变，长度归一化的漂移结构性为零；
			body 命中的行拿到的仍是「它在三列索引里的分数」，不会因为正文里
			多撞几个词就跳到标题命中行前面。
			"""
			rows = sim.execute(
				"""SELECT a.rowid, bm25(a, 5.0, 1.0, 1.0) AS s
				   FROM a JOIN b ON a.rowid = b.rowid
				   WHERE b MATCH ? ORDER BY s LIMIT 200""", (expr,)).fetchall()
			ranks["2stage"] = {r[0]: i + 1 for i, r in enumerate(rows)}
		else:
			for w in WEIGHTS:
				ranks[w] = rank_of(sim, expr, "b", f"5.0, 1.0, 1.0, {w}")
		sim.close()

		bestA = min([rankA[g] for g in gold if g in rankA], default=None)
		row = {
			"id": sid,
			"gold_rows": len(gold),
			"rankA": bestA,
			"inA": bestA is not None and bestA <= args.topk,
			"pool": len(avail),
		}
		for w in KEYS:
			best = min([ranks[w][g] for g in gold if g in ranks[w]], default=None)
			row[f"rankB_{w}"] = best
			row[f"inB_{w}"] = best is not None and best <= args.topk
		out.append(row)
		if args.limit and len(out) >= args.limit:
			break

	n = len(out)
	hitA = sum(1 for r in out if r["inA"])
	medA = statistics.median([r["rankA"] for r in out if r["rankA"]])
	print(f"题 {n}（{args.persona}，含证据轮的行必须存在）· 前 {args.topk} · 池是截止时全部事件行")
	print()
	print(f"  {'body 权重':>10} {'行进前%d' % args.topk:>10} {'变好':>5} {'变坏':>5} {'净':>8} {'名次中位':>8}")
	print(f"  {'无 body 列':>10} {hitA:>4} {hitA / n:>5.1%} {'':>5} {'':>5} {'':>8} {medA:>8.0f}")
	for w in KEYS:
		hitB = sum(1 for r in out if r[f"inB_{w}"])
		gain = [r for r in out if r[f"inB_{w}"] and not r["inA"]]
		loss = [r for r in out if r["inA"] and not r[f"inB_{w}"]]
		med = statistics.median([r[f"rankB_{w}"] for r in out if r[f"rankB_{w}"]])
		print(f"  {str(w):>10} {hitB:>4} {hitB / n:>5.1%} {len(gain):>5} {len(loss):>5} "
			f"{(len(gain) - len(loss)) / n * 100:>+6.1f}pt {med:>8.0f}")
	print()

	for w in KEYS:
		gain = [r for r in out if r[f"inB_{w}"] and not r["inA"]]
		loss = [r for r in out if r["inA"] and not r[f"inB_{w}"]]
		fresh = sum(1 for r in gain if r["rankA"] is None)
		print(f"  权重 {w}：变好 {len(gain)} 题（原本连前 50 都不在的 {fresh} 题 = 召回增益，"
			f"其余 {len(gain) - fresh} 题 = 排序增益）")
		# 掉出前 50 的行 `rankB` 是 None——那是更严重的变坏，排在最后而不是崩掉
		print(f"           变坏 {len(loss)} 题，新名次 "
			f"{sorted((r[f'rankB_{w}'] for r in loss), key=lambda v: (v is None, v))}")
	print()

	w0 = KEYS[0]
	gain = [r for r in out if r[f"inB_{w0}"] and not r["inA"]]
	if gain:
		print(f"  变好的题（权重 {w0}，前 6）：")
		for r in gain[:6]:
			print(f"    {r['id']} 名次 {r['rankA']} → {r[f'rankB_{w0}']} · 池 {r['pool']} · 证据行 {r['gold_rows']}")

	tag = ("-gate" if args.gate else "") + ("-gb" if args.gate_body else "")
	if args.gate_adaptive: tag += f"-ad{args.gate_adaptive}"
	if args.noise_body: tag += "-noise"
	if args.shuffle_body: tag += "-shuf"
	path = os.path.join(HERE, "work", f"body-sim-{args.persona}{tag}.jsonl")
	with open(path, "w", encoding="utf-8") as fh:
		for r in out:
			fh.write(json.dumps(r, ensure_ascii=False) + "\n")
	if args.dump_dropped and dropped:
		with open(args.dump_dropped, "w", encoding="utf-8") as fh:
			for sid in dropped:
				fh.write(sid + "\n")
		print(f"  闸门后无证据行的题 {len(dropped)} 道 → {args.dump_dropped}")
	print()
	print(f"  逐题产物 {os.path.relpath(path, os.path.dirname(HERE))}")


if __name__ == "__main__":
	main()
