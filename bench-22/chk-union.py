# -*- coding: utf-8 -*-
"""抽查：并集多算的那些题，证据轮的内容**真的进了提示词**吗。

翻案只有在能贴出原文时才成立。`turnsOfRefs` 解的是 `facts.source_ids` /
`events.l0_from..l0_to`——「抽这句话时读过哪些行」，不是「这句话里逐字引用了哪些行」。
若 `source_ids` 偏宽，覆盖率会被**朝好里**多算，而尺子的错一向偏在「看着变好了」那一边。

第一版用 `cover-22.py` 的 r10（整段原话 80% 的 10 字窗都得到）当判据，结果 84 道
翻案题里有 18 道「都对不上」。逐案看原文发现是**尺子太严**：证据轮常有几百字，
而提示词里只有那一段里最关键的一两句（被抽成 `#F` 行或截断的展开），
整段 80% 到不了，可那句话一字不差地在。

所以这里换成「**最长连续共有片段**」：从证据轮原话里滑窗，量提示词容纳了多长一段连续原文。
≥8 字算「原文到了」（8 字连续重合在中文里已经不可能碰巧），4–7 字算「只剩碎片」，
<4 字算「对不上」——只有最后一档才是多算。

读 `ab-turns.py --dump` 的产物，所以先跑那一个：

    python bench-22/ab-turns.py --ctx bench-22/work/ctx-0279 --dump bench-22/work/ctx-0279/ab-turns.jsonl
    python bench-22/chk-union.py
"""

import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get("BENCH22_DATA") or os.path.join(
	os.path.expanduser("~"), "Desktop", "cmb-2.2", "benchmark-2.2", "dataset"
)
CTX = os.path.join(HERE, "work", "ctx-0279")


def jl(path):
	with open(path, encoding="utf-8") as fh:
		return [json.loads(line) for line in fh if line.strip()]


def key(text):
	return re.sub(r"[^\u4e00-\u9fffA-Za-z0-9]", "", text or "")


def longest_common(prompt_key, quote_key, cap=40):
	"""最长的一段连续原文（按字）。从 8 起量，够用就停，省时间。"""
	best = 0
	n = len(quote_key)
	for size in range(min(cap, n), 3, -1):
		for i in range(0, n - size + 1):
			if quote_key[i : i + size] in prompt_key:
				return size
	return best


hist = {}
for p in ("M01", "M02"):
	hist[p] = {int(r["轮次"]): r for r in jl(os.path.join(DATA, "histories", f"{p}.jsonl"))}
key_by_id = {r["id"]: r for r in jl(os.path.join(DATA, "review-only", "answer-key.jsonl"))}
prompts = {}
for p in ("M01", "M02"):
	for r in jl(os.path.join(CTX, p, "contexts.jsonl")):
		prompts[r["id"]] = (p, r)

rows = jl(os.path.join(CTX, "ab-turns.jsonl"))
flipped = [r for r in rows if r["cov_base"] == 0 and r["cov_union"] > 0]
print(f"老口径 0、并集 >0 的翻案题：{len(flipped)} / {len(rows)}")

bucket = {"≥8 字原文到了": 0, "4–7 字碎片": 0, "<4 字对不上": 0}
spans = []
bad = []
for r in flipped:
	p, row = prompts[r["id"]]
	pk = key(row["prompt"])
	ev = [int(t) for t in r["evidence"] if int(t) in hist[p]]
	best = 0
	for t in ev:
		h = hist[p][t]
		for q in (h["用户消息"], h["助手回复"] or ""):
			best = max(best, longest_common(pk, key(q)))
	spans.append(best)
	if best >= 8:
		bucket["≥8 字原文到了"] += 1
	elif best >= 4:
		bucket["4–7 字碎片"] += 1
	else:
		bucket["<4 字对不上"] += 1
		bad.append((r["id"], best, r["cov_union"]))

for k, v in bucket.items():
	print(f"  {k:14} {v}")
spans.sort()
print(f"  最长共用片段：中位 {spans[len(spans) // 2]} 字，最小 {spans[0]} 字")

if bad:
	print()
	print("对不上的：")
	for sid, best, cov in bad[:10]:
		print(f"  {sid:14} 最长 {best} 字 · 并集覆盖 {cov}")
