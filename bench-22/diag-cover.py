# -*- coding: utf-8 -*-
"""为什么 loom 的轮次覆盖是 37.7%，而官方 BM25 基线是 59.2% —— 四路归因。

只看总数看不出原因：一道题「没覆盖」有四种互不相同的解释，且它们的修法完全
不在一个地方。这个脚本把每个漏掉的证据轮归到**唯一的一档**：

    1. 到了没记（尺子）  证据轮的原话就在提示词里，但 `used_turns` 没它
    2. 抽到了没检索到    库里有一行的来源覆盖这个轮次，但提示词里没有它
    3. 检索到了没归因     库里有行，行也在提示词里，但它的来源轮没进 `used_turns`
    4. 库里就没有（写侧） 这个轮次从没被抽成任何一行

第 3 档是最隐蔽的一个：`memory_search` 把事实/事件以摘要形式端出来，行上只有
`#F12`，**没有轮次**；桥的 `usedTurns` 只认 `#L` 区间和注入块里的原文匹配。
所以摘要行即使命中，也对覆盖率为零贡献。这一档要靠「行文本在不在提示词里」判。

    python bench-22/diag-cover.py --ctx bench-22/work/ctx-0278-full \
        --db M01=C:/.../loom22-dj3w2duf/loom.db --db M02=C:/.../loom22-prymbygh/loom.db
"""

import argparse
import json
import os
import re
import statistics
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get("BENCH22_DATA") or os.path.join(
	os.path.expanduser("~"), "Desktop", "cmb-2.2", "benchmark-2.2", "dataset"
)


def jl(path):
	with open(path, encoding="utf-8") as fh:
		return [json.loads(line) for line in fh if line.strip()]


def key(text):
	return re.sub(r"[^\u4e00-\u9fffA-Za-z0-9]", "", text or "")


def grams(text, n):
	s = key(text)
	if len(s) < n:
		return {s} if s else set()
	return {s[i : i + n] for i in range(len(s) - n + 1)}


def ratio(gram_set, quote, n):
	s = key(quote)
	if not s:
		return 0.0
	if len(s) < n:
		return 1.0 if s in gram_set else 0.0
	total = hit = 0
	for i in range(len(s) - n + 1):
		total += 1
		if s[i : i + n] in gram_set:
			hit += 1
	return hit / total if total else 0.0


def load_db(path):
	"""轮次 → 来源行。库是最终快照（整段历史都灌过），所以任何一题用到的轮都在里面。

	判定「抽到了」用的是产品的来源列，不是文本相似：`facts.source_ids` 是 l0 行号
	数组，`events` 有 `l0_from..l0_to`。两者都精确到行，再经 l0 折成轮次。
	"""
	import sqlite3

	db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
	rows = db.execute("SELECT id, turn, role FROM l0").fetchall()
	row_turn = {r[0]: r[1] for r in rows}
	role_of = {(r[1], r[2]): r[0] for r in rows}
	turn_rows = defaultdict(list)
	for rid, turn, role in rows:
		turn_rows[turn].append(rid)

	by_turn = defaultdict(list)
	for (fid, text, src) in db.execute("SELECT id, text, source_ids FROM facts WHERE status != 'merged'"):
		try:
			ids = json.loads(src or "[]")
		except ValueError:
			continue
		spread = set()
		for i in ids:
			if i in row_turn:
				spread.add(row_turn[i])
		for t in spread:
			by_turn[t].append(("F", fid, text))
	for (eid, lo, hi, title, summary) in db.execute("SELECT id, l0_from, l0_to, title, summary FROM events"):
		turns = {row_turn[i] for i in range(lo, hi + 1) if i in row_turn}
		for t in turns:
			by_turn[t].append(("E", eid, (title or "") + "\n" + (summary or "")))
	db.close()
	return {"by_turn": by_turn, "turn_rows": turn_rows, "role_of": role_of}


def main():
	ap = argparse.ArgumentParser()
	ap.add_argument("--ctx", default=os.path.join(HERE, "work", "ctx-0278-full"))
	ap.add_argument("--db", action="append", default=[], help="M01=<path>")
	ap.add_argument("--dump", default="", help="逐题明细写到这个 jsonl")
	args = ap.parse_args()
	dbs = dict(x.split("=", 1) for x in args.db)

	hist = {p: {int(r["轮次"]): r for r in jl(os.path.join(DATA, "histories", f"{p}.jsonl"))} for p in ("M01", "M02")}
	key_by_id = {r["id"]: r for r in jl(os.path.join(DATA, "review-only", "answer-key.jsonl"))}

	out_rows = []
	stat = Counter()
	per = {}
	for persona in ("M01", "M02"):
		path = os.path.join(args.ctx, persona, "contexts.jsonl")
		if not os.path.exists(path):
			continue
		idx = load_db(dbs[persona]) if persona in dbs else None
		rows = jl(path)
		sub = {"n": 0, "covered": 0, "ev": 0, "ev_hit": 0, "cls": Counter(), "dist": [], "chars": []}
		for row in rows:
			k = key_by_id.get(row["id"]) or {}
			turns = [int(t) for t in (k.get("evidence_turns") or []) if int(t) in hist[persona]]
			if not turns:
				continue
			sub["n"] += 1
			used = {int(t) for t in (row.get("used_turns") or [])}
			prompt = row["prompt"]
			sub["chars"].append(len(prompt))
			hit_any = any(t in used for t in turns)
			sub["covered"] += 1 if hit_any else 0
			p10 = grams(prompt, 10)
			sub["ev"] += len(turns)
			sub["ev_hit"] += sum(1 for t in turns if t in used)
			sub["dist"].append(row["cutoff_turn"] - min(turns))
			cls_of_q = []
			for t in turns:
				h = hist[persona][t]
				# 该轮的原话是否整段在提示词里
				r10 = max(ratio(p10, h["用户消息"], 10), ratio(p10, h["助手回复"], 10))
				in_prompt = r10 >= 0.8
				has = idx["by_turn"].get(t, []) if idx else []
				# 库里的行是不是端在提示词里了（取行文本前 16 个汉字做指纹）
				row_in_prompt = False
				row_best = 0.0
				for kind, rid, text in has:
					g = grams(text, 10)
					row_best = max(
						row_best,
						ratio(g, h["用户消息"], 10),
						ratio(g, h["助手回复"], 10),
					)
					fp = key(text)[:16]
					if len(fp) >= 10 and fp in key(prompt):
						row_in_prompt = True
				if t in used:
					cls = "covered"
				elif in_prompt:
					cls = "1_到了没记"
				elif row_in_prompt:
					cls = "3_到了没归因"
				elif has and row_best >= 0.5:
					cls = "2_抽到没检索"
				elif has:
					cls = "4_写侧丢内容"
				elif idx is not None:
					cls = "5_库里没有"
				else:
					cls = "?"
				sub["cls"][cls] += 1
				cls_of_q.append((t, cls, round(r10, 3), len(has), row["cutoff_turn"] - t))
			# 题目级：没覆盖时，按「最好的那一档」归因（1 > 3 > 2 > 4）
			if not hit_any and idx is not None:
				order = ["1_到了没记", "3_到了没归因", "2_抽到没检索", "4_写侧丢内容", "5_库里没有"]
				for want in order:
					if any(c[1] == want for c in cls_of_q):
						sub["q_" + want] = sub.get("q_" + want, 0) + 1
						break
			out_rows.append(
				{"id": row["id"], "persona": persona, "cutoff": row["cutoff_turn"],
				 "used_n": len(used), "turns": turns, "cls": cls_of_q,
				 "prompt_chars": len(prompt), "prompt": prompt if not hit_any else ""}
			)
		per[persona] = sub

	# ---------------------------------------------------------------- 报表
	tot = Counter()
	print(f"=== 逐档归因（按证据轮，{args.ctx}）===")
	for persona, sub in per.items():
		n_cls = sum(sub["cls"].values())
		print(f"\n{persona}：{sub['n']} 题 · 证据轮 {n_cls} 个 · 轮次命中 {sub['ev_hit']} = {sub['ev_hit'] / max(1, n_cls) * 100:.1f}%")
		print(f"  题级覆盖 {sub['covered']}/{sub['n']} = {sub['covered'] / sub['n'] * 100:.1f}%")
		print(f"  提示词中位 {statistics.median(sub['chars']):,.0f} 字 · used_turns 中位 " + str(len(sub["dist"]) and ""))
		for cls, c in sub["cls"].most_common():
			print(f"    {cls:<14} {c:>5}  ({c / max(1, n_cls) * 100:5.1f}%)")
			tot[cls] += c
		for cls in ("q_1_到了没记", "q_3_到了没归因", "q_2_抽到没检索", "q_4_库里没有"):
			if cls in sub:
				print(f"    题级 {cls[2:]:<12} {sub[cls]}")
	n_all = sum(tot.values())
	print(f"\n=== 合计证据轮 {n_all} 个 ===")
	for cls, c in tot.most_common():
		print(f"  {cls:<14} {c:>5}  ({c / max(1, n_all) * 100:5.1f}%)")

	# 距离分桶：漏掉的证据轮离截止轮多远
	print("\n=== 离截止轮的距离（中位/分位）===")
	for persona, sub in per.items():
		d = sub["dist"]
		if d:
			d = sorted(d)
			print(f"  {persona} 中位 {statistics.median(d):.0f} 轮 · "
				f"P25 {d[len(d) // 4]} · P75 {d[len(d) * 3 // 4]} · 最小 {d[0]}")

	if args.dump:
		with open(args.dump, "w", encoding="utf-8") as fh:
			for r in out_rows:
				fh.write(json.dumps(r, ensure_ascii=False) + "\n")
		print(f"\n明细 -> {args.dump}")


if __name__ == "__main__":
	main()
