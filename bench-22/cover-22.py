# -*- coding: utf-8 -*-
"""2.2 考试榜的证据覆盖 —— 三个口径分开量，不混成一个数。

官方 A 分要模型答题再判分。本地能算的只有「材料到没到」，而「到没到」有三种
互不相同的读法，混在一起就会出现归因错误（把「原话没逐字进」说成「材料没到」）：

1. **轮次**：`used_turns` 有没有覆盖答案键的 `evidence_turns`。这是定位口径，
   与 `retrieval-hit.mjs` 同源。它说「模型知不知道这件事在哪」。
2. **原话**：证据轮的原话切 10 字窗，`r10 >= 0.8` 算到。这是内容口径。
3. **词面**：同一对文本切 2 字窗，`r2 >= 0.8` 算撞上。它分辨「只有几个词对上」
   和「整句到了」。

第 2 条对这套语料天然偏低：2.2 的事实被改写成第三人称摘要（「用户…」），原话
逐字不会出现在派生行里，只有展开的那两条才有原话。所以它低不等于材料没到——
要看第 1 条和第 3 条。

    python bench-22/cover-22.py --ctx work/ctx-0278
"""

import argparse
import json
import os
import re
import statistics

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get("BENCH22_DATA") or os.path.join(
	os.path.expanduser("~"), "Desktop", "cmb-2.2", "benchmark-2.2", "dataset"
)


def jl(path):
	with open(path, encoding="utf-8") as fh:
		return [json.loads(line) for line in fh if line.strip()]


def key(text):
	"""留汉字、字母、数字；空白与标点全部去掉。与 714 那套的 `key()` 一致。"""
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


def main():
	ap = argparse.ArgumentParser()
	ap.add_argument("--ctx", default=os.path.join(HERE, "work", "ctx-0278"))
	ap.add_argument("--natural", default=os.path.join(HERE, "work", "natural-0277.jsonl"))
	args = ap.parse_args()

	hist = {}
	for p in ("M01", "M02"):
		hist[p] = {int(r["轮次"]): r for r in jl(os.path.join(DATA, "histories", f"{p}.jsonl"))}
	key_by_id = {r["id"]: r for r in jl(os.path.join(DATA, "review-only", "answer-key.jsonl"))}

	total = {"rows": 0, "turn_hit": 0, "r10": 0, "r2": 0}
	for persona in ("M01", "M02"):
		path = os.path.join(args.ctx, persona, "contexts.jsonl")
		if not os.path.exists(path):
			continue
		rows = jl(path)
		turn_hits, r10s, r2s, miss = [], [], [], []
		for row in rows:
			k = key_by_id.get(row["id"]) or {}
			turns = [int(t) for t in (k.get("evidence_turns") or []) if int(t) in hist[persona]]
			if not turns:
				continue
			used = {int(t) for t in (row.get("used_turns") or [])}
			th = sum(1 for t in turns if t in used) / len(turns)
			pg10, pg2 = grams(row["prompt"], 10), grams(row["prompt"], 2)
			best10 = best2 = 0.0
			for t in turns:
				h = hist[persona][t]
				for quote in (h["用户消息"], h["助手回复"]):
					best10 = max(best10, ratio(pg10, quote, 10))
					best2 = max(best2, ratio(pg2, quote, 2))
			turn_hits.append(th)
			r10s.append(best10)
			r2s.append(best2)
			if th == 0:
				miss.append((row["id"], round(best2, 3), row["id"]))
		n = len(turn_hits)
		total["rows"] += n
		total["turn_hit"] += sum(1 for x in turn_hits if x > 0)
		total["r10"] += sum(1 for x in r10s if x >= 0.8)
		total["r2"] += sum(1 for x in r2s if x >= 0.8)
		print(f"=== {persona}：{n} 题有证据轮 ===")
		print(f"  轮次覆盖（used_turns 撞上证据轮）  {sum(1 for x in turn_hits if x > 0)}/{n} = {sum(1 for x in turn_hits if x > 0) / n * 100:.1f}%  · 均值 {statistics.mean(turn_hits):.3f}")
		print(f"  原话逐字（r10≥0.8）              {sum(1 for x in r10s if x >= 0.8)}/{n} = {sum(1 for x in r10s if x >= 0.8) / n * 100:.1f}%  · 中位 {statistics.median(r10s):.3f}")
		print(f"  词面撞上（r2≥0.8）               {sum(1 for x in r2s if x >= 0.8)}/{n} = {sum(1 for x in r2s if x >= 0.8) / n * 100:.1f}%  · 中位 {statistics.median(r2s):.3f}")
		print(f"  三者全中                          {sum(1 for a, b, c in zip(turn_hits, r10s, r2s) if a > 0 and b >= 0.8 and c >= 0.8)}/{n}")
		print()

	n = total["rows"]
	print(f"=== 合计 {n} 题 ===")
	print(f"  轮次 {total['turn_hit'] / n * 100:.1f}% · 原话 {total['r10'] / n * 100:.1f}% · 词面 {total['r2'] / n * 100:.1f}%")
	print()

	nat = args.natural
	if os.path.exists(nat):
		rows = jl(nat)
		ok = sum(1 for r in rows if (r.get("ev_total") or 0) > 0 and (r.get("ev_hit") or 0) >= (r.get("ev_total") or 0))
		ht = sum(r.get("ev_hit") or 0 for r in rows)
		tt = sum(r.get("ev_total") or 0 for r in rows)
		th = sum(1 for r in rows if (r.get("turn_hit") or 0) > 0)
		print(f"=== 自然榜（{len(rows)} 题；官方 8 字窗口径）===")
		print(f"  证据行命中 {ht}/{tt} = {ht / max(1, tt) * 100:.1f}%")
		print(f"  每题全中 {ok}/{len(rows)} = {ok / len(rows) * 100:.1f}%")
		print(f"  轮次覆盖 {th}/{len(rows)} = {th / len(rows) * 100:.1f}%")


if __name__ == "__main__":
	main()
