# -*- coding: utf-8 -*-
"""逐题解剖「BM25 想起来、我们没想起来」的那几题。

D2 的分型读数里，X（30 题）与 Y（14 题）我们已经和 BM25 打平，掉队的 5 题全在
H（9/12 对 12/12）与 Z（5/14 对 7/14）。所以别再泛泛地加机制，先把这 7 道
（BM25 独有命中的题）逐题解剖：**承载轮到底在不在我们的提示词里**。

判据分三层，从松到严：

1. **整句在不在**：该轮 user 原文的 8 字窗有多少落进提示词（就是主判据）；
2. **片段在不在**：换成 6 字窗——落到 6 字还全灭，说明这一整句根本没端上来；
3. **有没有该轮的任何字**：拿该轮原文随机取 5 个 4 字片段，全灭就是彻底没见面。

    python bench-22/diag-natural-miss.py
"""

import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get("BENCH22_DATA") or os.path.join(HERE, "..", "..", "cmb-2.2", "benchmark-2.2", "dataset")
if not os.path.isdir(DATA):
	DATA = os.path.join(os.path.expanduser("~"), "Desktop", "cmb-2.2", "benchmark-2.2", "dataset")

OURS = os.path.join(HERE, "work", "natural-22-v6.jsonl")
BM25 = os.path.join(HERE, "work", "natural-bm25-recent6.jsonl")
PREFIX = re.compile(r"^第\d+轮\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+[^\s:：]+[:：]\s*(.+)$")
EVIDENCE_LINE = re.compile(r"(?:user|assistant|用户|助手)\s*[:：]\s*(.+)$")


def jl(path):
	with open(path, encoding="utf-8") as fh:
		return [json.loads(line) for line in fh if line.strip()]


def squash(text):
	return re.sub(r"\s+", "", text or "")


def windows(text, size):
	body = squash(text)
	if len(body) <= size:
		return [body] if len(body) >= 4 else []
	return [body[i : i + size] for i in range(len(body) - size + 1)]


def evidence_texts(evidence):
	out = []
	for line in (evidence or "").splitlines():
		line = line.strip().lstrip("-").strip()
		if not line:
			continue
		m = PREFIX.match(line) or EVIDENCE_LINE.search(line)
		if m:
			out.append(m.group(1).strip())
			continue
		out.append(re.sub(r"^F\d+[:：]\s*", "", line))
	return [x for x in out if len(squash(x)) >= 4]


def main():
	ours = {r["id"]: r for r in jl(OURS)}
	bm = {r["id"]: r for r in jl(BM25)}
	keys = {k["id"]: k for k in jl(os.path.join(DATA, "natural", "natural-key-dev.jsonl"))}
	hist = {}
	for p in ("M01", "M02"):
		hist[p] = {
			int(r["轮次"]): r
			for r in jl(os.path.join(DATA, "histories", f"{p}.jsonl"))
		}

	ids = [i for i in ours if bm[i]["cover_any"] and not ours[i]["cover_any"]]
	ids.sort()
	print(f"BM25 想起、我们没想起：{len(ids)} 题\n")
	for i in ids:
		o, k = ours[i], keys[i]
		print("=" * 78)
		print(f"{i}  [{k['class']}]  截止第 {o['cutoff_turn']} 轮  token {o['tokens']}  refs {o['refs']}")
		print(f"  问：{k.get('probe', {}).get('user')}")
		evs = evidence_texts(k.get("evidence"))
		ev_turns = sorted({int(n) for n in re.findall(r"第(\d+)轮", k.get("evidence") or "")})
		print(f"  承载轮 {ev_turns}  我们自报 used_turns {o['used_turns'][:12]}{'…' if len(o['used_turns']) > 12 else ''}")
		body = squash(o["prompt"])
		for ev in evs:
			w8 = windows(ev, 8)
			w6 = windows(ev, 6)
			h8 = sum(1 for w in w8 if w in body)
			h6 = sum(1 for w in w6 if w in body)
			print(f"    证据 8字窗 {h8}/{len(w8)}  6字窗 {h6}/{len(w6)}  「{squash(ev)[:36]}」")
		# 承载轮原文到底在不在提示词里
		for t in ev_turns:
			row = hist[o["persona"]].get(t)
			if not row:
				continue
			text = squash(row["用户消息"])
			w = windows(text, 4)
			hit = sum(1 for x in w if x in body)
			print(f"    第{t}轮原文 {len(text)} 字，4 字片段命中 {hit}/{len(w)}（{hit / max(len(w), 1) * 100:.0f}%）")
			print(f"      原文：{text[:60]}")
		# 我们端上来的都是什么
		heads = re.findall(r"【正文 · (#[A-Z]\d+(?:-\d+)?[^】]*)】", o["prompt"])
		print(f"  提示词里的正文段（{len(heads)}）：{heads[:8]}")
		sec = o["prompt"].split("【检索到的记忆】")
		if len(sec) > 1:
			first = [l for l in sec[1].splitlines() if l.strip()][:6]
			print("  检索段开头：")
			for l in first:
				print(f"    {l[:100]}")
		print()
	return 0


if __name__ == "__main__":
	sys.exit(main())
