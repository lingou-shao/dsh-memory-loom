# -*- coding: utf-8 -*-
"""两个取面产物逐题对比：覆盖、字符、席位、以及「答案要素到了没有」。

`ab-turns.py` 只比一个数（`cov_union`），而 §125 要同时看四件互相牵制的事：

  1. 覆盖率与逐题好/坏（是不是零和）
  2. 记忆文本字符数（成本这一头）
  3. 引用条数（席位用掉多少）
  4. 答案键 `rubric.required` 的二元组有多少落进提示词，与「证据轮原文」这个
     天花板比 —— 只有这一项看得见「钩子换成全文」的收益，`cov_union` 看不见

    python bench-22/cmp-tail.py --base work/ctx-0279 --arm work/ctx-tailA
"""

import argparse
import json
import os
import re
import sqlite3
import statistics
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get("BENCH22_DATA") or os.path.join(
	os.path.expanduser("~"), "Desktop", "cmb-2.2", "benchmark-2.2", "dataset")
DB = {"M01": os.path.join(HERE, "work", "db", "M01-5668.db"), "M02": os.path.join(HERE, "work", "db", "M02-5413.db")}
CJK = re.compile(r"[\u4e00-\u9fff]")
REF = re.compile(r"#([FEPL]\d+(?:-\d+)?)")
HEAD = re.compile(r"【正文 · (#[FEPL]\d+(?:-\d+)?)")
SPAN = re.compile(r"^L(\d+)(?:-(\d+))?$")


def jl(path):
	with open(path, encoding="utf-8") as fh:
		return [json.loads(line) for line in fh if line.strip()]


def grams(text):
	clean = CJK.findall(text)
	return {clean[i] + clean[i + 1] for i in range(len(clean) - 1)}


def sections(prompt):
	tail = prompt.split("【检索到的记忆】", 1)
	if len(tail) < 2:
		return [], set()
	rest = tail[1]
	cut = rest.find("\n\n【原话】")
	listing = rest if cut < 0 else rest[:cut]
	order = []
	for one in REF.findall(listing):
		if one not in order:
			order.append(one)
	return order, set(HEAD.findall(prompt))


def tier(prompt, ev_key, span):
	"""金标行给模型的是全文（1）、一行钩子（2），还是连列表都没进（0）。"""
	order, expanded = sections(prompt)
	if span is None:
		return 0
	want = "#" + ev_key if ev_key else None
	for ref in order:
		hit = want is not None and "#" + ref == want
		m = SPAN.match(ref)
		if not hit and m is not None:
			a, b = int(m.group(1)), int(m.group(2) or m.group(1))
			hit = not (b < span[0] or a > span[1])
		if hit:
			return 1 if "#" + ref in expanded else 2
	return 0


def load(root, persona):
	path = os.path.join(root, persona, "contexts.jsonl")
	return {r["id"]: r for r in jl(path)} if os.path.exists(path) else {}


def main():
	ap = argparse.ArgumentParser()
	ap.add_argument("--base", default=os.path.join(HERE, "work", "ctx-0279"))
	ap.add_argument("--arm", required=True)
	args = ap.parse_args()

	key = {r["id"]: r for r in jl(os.path.join(DATA, "review-only", "answer-key.jsonl"))}
	cov_base = {r["id"]: r.get("cov_union", 0) for r in jl(os.path.join(args.base, "ab-turns.jsonl"))}
	# `ab-turns.py` 的口径是「证据轮 ∩ 历史轮」：题库键里偶尔有历史里不存在的轮次，
	# 那几轮永远不可能出现在提示词里，不排掉会把两边的分母搞成不一样。
	hist = {
		p: {int(r["轮次"]) for r in jl(os.path.join(DATA, "histories", "%s.jsonl" % p))}
		for p in ("M01", "M02")
	}

	for persona in ("M01", "M02"):
		base, arm = load(args.base, persona), load(args.arm, persona)
		if not base or not arm:
			continue
		ids = [k for k in base if k in arm]

		con = sqlite3.connect(DB[persona])
		ev = {"E%s" % i: (f, t) for i, f, t in con.execute("select id, l0_from, l0_to from events")}
		l0 = {}
		for turn, text in con.execute("select turn, text from l0"):
			l0.setdefault(int(turn), []).append(text)
		con.close()
		gold = {r["id"]: r for r in jl(os.path.join(HERE, "work", "gate-why-%s.jsonl" % persona))}

		n = up = down = covb = cova = hitb = hita = 0
		charb = chara = 0
		rb, ra = [], []
		tb, ta = Counter(), Counter()
		qb, qa, qc = [], [], []
		for sid in ids:
			k = key.get(sid) or {}
			turns = set(int(t) for t in k.get("evidence_turns") or []) & hist[persona]
			if not turns:
				continue
			n += 1
			union = set(int(t) for t in (arm[sid].get("used_turns") or []))
			a = round(len(turns & union) / len(turns), 4)
			b = cov_base.get(sid, 0.0)
			covb += b >= 1.0
			cova += a >= 1.0
			hitb += b > 0
			hita += a > 0
			up += a > b
			down += a < b
			charb += len(base[sid]["prompt"])
			chara += len(arm[sid]["prompt"])
			ob, oa = sections(base[sid]["prompt"])[0], sections(arm[sid]["prompt"])[0]
			rb.append(len(ob))
			ra.append(len(oa))

			g = gold.get(sid)
			raw = "".join(sum((l0.get(t, []) for t in sorted(turns)), []))
			span, evk = None, None
			if g:
				mid = g.get("ev")
				span = ev.get("E%s" % mid)
				evk = "E%s" % mid if span is not None else None
			tb[tier(base[sid]["prompt"], evk, span)] += 1
			ta[tier(arm[sid]["prompt"], evk, span)] += 1

			req = [x for x in (k.get("rubric") or {}).get("required") or [] if len(grams(x)) >= 3]
			if req:
				pset, aset = grams(base[sid]["prompt"]), grams(arm[sid]["prompt"])
				rs = grams(raw)
				qb.append(sum(len(grams(r) & pset) / len(grams(r)) for r in req) / len(req))
				qa.append(sum(len(grams(r) & aset) / len(grams(r)) for r in req) / len(req))
				qc.append(sum(len(grams(r) & rs) / len(grams(r)) for r in req) / len(req))

		print("=== %s · %d 题 ===" % (persona, n))
		print("  命中(>=1轮)  %5.1f%% -> %5.1f%%" % (100.0 * hitb / n, 100.0 * hita / n))
		print("  满覆盖      %5.1f%% -> %5.1f%%   好 %d / 坏 %d（净 %+d）" % (
			100.0 * covb / n, 100.0 * cova / n, up, down, up - down))
		print("  记忆文本    %s -> %s  (%+.1f%%)" % (
			f"{charb:,}", f"{chara:,}", 100.0 * (chara - charb) / charb))
		print("  引用条数    中位 %.0f -> %.0f" % (statistics.median(rb), statistics.median(ra)))
		print("  金标行三档  全文 %d / 钩子 %d / 缺席 %d  ->  全文 %d / 钩子 %d / 缺席 %d" % (
			tb[1], tb[2], tb[0], ta[1], ta[2], ta[0]))
		if qb:
			print("  答案要素    提示词 %.3f -> %.3f · 证据原文天花板 %.3f（%d 题）" % (
				statistics.mean(qb), statistics.mean(qa), statistics.mean(qc), len(qb)))
		print()


if __name__ == "__main__":
	main()
