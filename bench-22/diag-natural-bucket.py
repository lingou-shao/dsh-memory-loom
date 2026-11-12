# -*- coding: utf-8 -*-
"""我们漏掉的题，字面上到底能不能找到 —— 把 34 道漏检按「共享词」分桶。

分桶比「逐题读提示词」快得多，也比凭印象可靠。判据只看一件事：
**问句和承载轮原文有没有共同的实词二元组**。

- **N（零共享）**：一个共有实词都没有。字面通道无论如何都到不了，要么靠日期/时刻
  这类结构，要么靠语义——`clockRules`、`dateRules` 是前者。
- **F（共享薄）**：只有 1 个共有实词。bm25 的闸门（问句二元组占比 0.25）过不去，
  它属于 §65 那类「误杀」，可以修。
- **R（共享足）**：≥2 个共有实词。材料和问句字面通得过，没端出来就是池子/名额问题。

    python bench-22/diag-natural-bucket.py [--arm work/natural-22-v6.jsonl]
"""

import argparse
import json
import os
import re
import sys
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get("BENCH22_DATA") or os.path.join(HERE, "..", "..", "cmb-2.2", "benchmark-2.2", "dataset")
if not os.path.isdir(DATA):
	DATA = os.path.join(os.path.expanduser("~"), "Desktop", "cmb-2.2", "benchmark-2.2", "dataset")

# 与 lib/index.js 的 THIN_CHARS 同一套字（虚词表）。判据取保守的一边：
# 二元组里只要有一个这样的字就整条算虚（见 `isThinToken` 的注释）。
THIN = set(
	"怎么什哪几谁啥呀吗呢吧啊嘛的了是在和与就也都还又再只才而且或不没我你他她它们这那个些后前当时今明昨天年月日号点早晚最初先次来"
)
CJK = re.compile(r"[\u4e00-\u9fff]+")


def jl(path):
	with open(path, encoding="utf-8") as fh:
		return [json.loads(line) for line in fh if line.strip()]


def tokens(text):
	"""中文二元组 + 拉丁词，和 `tokensOf` 的口径一致到「够用」。"""
	out = []
	for run in CJK.findall(text or ""):
		if len(run) == 1:
			out.append(run)
		out.extend(run[i : i + 2] for i in range(len(run) - 1))
	out.extend(w.lower() for w in re.findall(r"[A-Za-z0-9]{2,}", text or ""))
	return out


def solid(toks):
	return [t for t in toks if any(c not in THIN for c in t)]


def main():
	ap = argparse.ArgumentParser()
	ap.add_argument("--arm", default=os.path.join(HERE, "work", "natural-22-v6.jsonl"))
	ap.add_argument("--show", type=int, default=0, help="每桶打印前 N 题明细")
	args = ap.parse_args()

	ours = {r["id"]: r for r in jl(args.arm)}
	keys = {k["id"]: k for k in jl(os.path.join(DATA, "natural", "natural-key-dev.jsonl"))}
	probes = {p["id"]: p for p in jl(os.path.join(DATA, "natural", "natural-probes-dev.jsonl"))}
	hist = {}
	for p in ("M01", "M02"):
		hist[p] = {int(r["轮次"]): r for r in jl(os.path.join(DATA, "histories", f"{p}.jsonl"))}

	buckets = Counter()
	detail = {"N": [], "F": [], "R": []}
	for pid, row in ours.items():
		if row["cover_any"]:
			continue
		question = probes[pid]["probe"]["user"]
		qt = set(solid(tokens(question)))
		carry = set()
		for t in row.get("ev_turns") or []:
			r = hist[row["persona"]].get(t)
			if r:
				carry |= set(solid(tokens(r["用户消息"])))
		shared = qt & carry
		key = "N" if not shared else ("F" if len(shared) == 1 else "R")
		buckets[key] += 1
		detail[key].append((pid, keys[pid]["subtype"], sorted(shared)[:8], question[:40]))

	total = sum(buckets.values())
	print(f"漏检 {total} 题（{os.path.basename(args.arm)}，8 字窗判据）\n")
	names = {"N": "零共享（字面到不了）", "F": "只共享 1 个实词（闸门误杀）", "R": "≥2 个共享实词（池子/名额）"}
	for k in ("N", "F", "R"):
		print(f"  {k}  {buckets[k]:2} 题  {buckets[k] / total * 100:4.1f}%  {names[k]}")
	print()
	for k in ("N", "F", "R"):
		if not args.show:
			continue
		print(f"— {k} —")
		for pid, st, shared, q in detail[k][: args.show]:
			print(f"  {pid:18} {st:4} 共享 {shared}  问：{q}")
		print()
	return 0


if __name__ == "__main__":
	sys.exit(main())
