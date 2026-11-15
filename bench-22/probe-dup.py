# -*- coding: utf-8 -*-
"""十个席位里有多少条其实是同一件事：事件摘要与原话指针的重复率。

`§124.5` 量到「追加档的第一条之后，第二条总是同类的重复行」，理由是 `repeated`
只丢**逐字相同**的。但列表本身上下也有这个病：同一个轮次常常同时以 `#E`（改写
摘要）和 `#L`（原话指针）出现两次。逐字不同，`repeated` 看不见，于是两个席位
装了同一件事。

这个脚本从已经取好的提示词里把「检索到的记忆」那十行拆出来，两两算二元组
Jaccard，数三个东西：

  1. 每题有多少行与前面某行重复（≥0.6）
  2. 这些重复行里，`#E` 与 `#L` 配对的有多少（同一轮的两种写法）
  3. 若把这些重复行放掉，空出的席位按原顺序往后补，还能补到几条新行

    python bench-22/probe-dup.py --ctx work/ctx-0279 --persona M02
"""

import argparse
import json
import os
import re
import statistics
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
ROW = re.compile(r"(?m)^\s*\d+\. \[")
REF = re.compile(r"#([FEPL]\d+(?:-\d+)?)")


def parse_rows(listing):
	"""按 `^N. [` 切块，每块取第一个编号与 `]` 之后的正文。

	不用一条大正则：行正文里有换行（截断的原话会跨行），而编号总是出现在块内
	第一次出现的位置，切块比一次匹配稳。
	"""
	marks = [m.start() for m in ROW.finditer(listing)]
	out = []
	for i, at in enumerate(marks):
		end = marks[i + 1] if i + 1 < len(marks) else len(listing)
		chunk = listing[at:end]
		ref = REF.search(chunk)
		if ref is None:
			continue
		text = chunk[chunk.index("]") + 1:ref.start()] if "]" in chunk else ""
		out.append((ref.group(1), text.strip()))
	return out
CJK = re.compile(r"[\u4e00-\u9fff]")


def jl(path):
	with open(path, encoding="utf-8") as fh:
		return [json.loads(line) for line in fh if line.strip()]


def grams(text):
	clean = CJK.findall(text)
	if len(clean) < 2:
		return set()
	return {clean[i] + clean[i + 1] for i in range(len(clean) - 1)}


def jac(a, b):
	if not a or not b:
		return 0.0
	return len(a & b) / len(a | b)


def main():
	ap = argparse.ArgumentParser()
	ap.add_argument("--ctx", default=os.path.join(HERE, "work", "ctx-0279"))
	ap.add_argument("--persona", default="M02")
	ap.add_argument("--sim", type=float, default=0.6)
	ap.add_argument("--dump", default="")
	args = ap.parse_args()

	rows = jl(os.path.join(args.ctx, args.persona, "contexts.jsonl"))
	dup_hist = Counter()
	pair_kind = Counter()
	per_q = []
	sizes = Counter()

	for row in rows:
		body = row["prompt"].split("【检索到的记忆】", 1)
		if len(body) < 2:
			continue
		rest = body[1]
		cut = rest.find("\n\n【原话】")
		listing = rest if cut < 0 else rest[:cut]
		items = parse_rows(listing)
		if not items:
			continue
		sizes[len(items)] += 1
		kinds = [ref[0] for ref, _ in items]
		texts = [text for _, text in items]
		sets = [grams(t) for t in texts]

		redundant = 0
		dead = set()
		for i in range(len(items)):
			for j in range(i):
				if j in dead:
					continue
				if jac(sets[i], sets[j]) >= args.sim:
					dead.add(i)
					redundant += 1
					pair_kind["%s×%s" % tuple(sorted((kinds[j], kinds[i])))] += 1
					break
		dup_hist[min(redundant, 5)] += 1
		per_q.append(dict(id=row["id"], n=len(items), dup=redundant))

	tot = len(per_q)
	print("%s · %d 题（有检索段）· 二元组 Jaccard >= %.2f 判为同一件事" % (args.persona, tot, args.sim))
	print()
	print("  %-22s %5s %7s" % ("每题重复行数", "题数", "占比"))
	for k in sorted(dup_hist):
		label = str(k) if k < 5 else "5+"
		print("  %-22s %5d %6.1f%%" % (label, dup_hist[k], 100.0 * dup_hist[k] / tot))
	print()
	vals = [p["dup"] for p in per_q]
	print("  平均 %.2f 条 / 中位 %.1f 条 / p90 %d 条" % (
		statistics.mean(vals), statistics.median(vals), sorted(vals)[int(len(vals) * 0.9)]))
	print("  一条都不重复的题：%d = %.1f%%" % (
		sum(1 for v in vals if v == 0), 100.0 * sum(1 for v in vals if v == 0) / tot))
	print()
	print("  重复配对是哪两种编号：")
	for k, v in pair_kind.most_common(8):
		print("    %-8s %4d" % (k, v))
	print()
	print("  列表行数分布：", dict(sorted(sizes.items())))

	if args.dump:
		with open(args.dump, "w", encoding="utf-8") as fh:
			for d in per_q:
				fh.write(json.dumps(d, ensure_ascii=False) + "\n")


if __name__ == "__main__":
	main()
