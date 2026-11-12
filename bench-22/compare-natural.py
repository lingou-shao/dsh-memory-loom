# -*- coding: utf-8 -*-
"""自然用记忆榜：把几臂的取面产物横向对齐。

    python bench-22/compare-natural.py bench-22/work/natural-22.jsonl \
        bench-22/work/natural-bm25.jsonl bench-22/work/natural-recent6.jsonl

只做两件事：

1. 同一批探针上的「材料到没到」并排（按人、按 class）；
2. 两臂逐题比对，列出**只在一边沾到**的题号——这是「我们到底强在哪」的唯一证据。

所有数字都是代理量：8 字窗覆盖，不是 A 分。
"""

import argparse
import json
import os
import statistics
import sys


def jl(path):
	out = []
	with open(path, encoding="utf-8") as fh:
		for line in fh:
			if line.strip():
				out.append(json.loads(line))
	return out


def label(path):
	base = os.path.basename(path)
	return base.replace("natural-", "").replace(".jsonl", "")


def main():
	ap = argparse.ArgumentParser()
	ap.add_argument("files", nargs="+")
	ap.add_argument("--pairs", action="store_true", help="打印两臂逐题差异")
	args = ap.parse_args()

	arms = {label(p): {r["id"]: r for r in jl(p)} for p in args.files}
	names = list(arms)
	ids = sorted(set.intersection(*[set(v) for v in arms.values()]))
	print(f"共同探针 {len(ids)} 个；臂 = {', '.join(names)}\n")

	print(f"{'臂':<16}{'人':<6}{'n':>4}{'全中':>7}{'沾到':>7}{'全中%':>8}{'沾到%':>8}{'token中位':>11}{'C(¥)':>8}")
	for name in names:
		for persona in ("M01", "M02", "ALL"):
			rows = [arms[name][i] for i in ids if persona == "ALL" or arms[name][i]["persona"] == persona]
			if not rows:
				continue
			n = len(rows)
			cf = sum(r["cover_full"] for r in rows)
			ca = sum(r["cover_any"] for r in rows)
			tok = sum(r["tokens"] for r in rows)
			print(
				f"{name:<16}{persona:<6}{n:>4}{cf:>7}{ca:>7}{cf / n * 100:>7.1f}%{ca / n * 100:>7.1f}%"
				f"{statistics.median(r['tokens'] for r in rows):>11.0f}{tok * 1.296e-6:>8.3f}"
			)

	print(f"\n官方轮次口径（used_turns ∩ 证据轮）：沾到 / 全中 / n")
	print(f"{'臂':<16}{'人':<6}{'n':>4}{'轮沾到':>8}{'轮全中':>8}{'轮沾到%':>9}")
	for name in names:
		for persona in ("M01", "M02", "ALL"):
			rows = [arms[name][i] for i in ids if persona == "ALL" or arms[name][i]["persona"] == persona]
			if not rows:
				continue
			n = len(rows)
			ta = sum(1 for r in rows if r.get("turn_any"))
			tf = sum(1 for r in rows if r.get("turn_full"))
			print(f"{name:<16}{persona:<6}{n:>4}{ta:>8}{tf:>8}{ta / n * 100:>8.1f}%")

	print(f"\n按 class（全中 / 沾到 / n）：")
	classes = sorted({arms[names[0]][i]["class"] for i in ids})
	head = "class".ljust(8) + "".join(n[:14].ljust(18) for n in names)
	print(head)
	for cls in classes:
		line = cls.ljust(8)
		for name in names:
			rows = [arms[name][i] for i in ids if arms[name][i]["class"] == cls]
			line += f"{sum(r['cover_full'] for r in rows)}/{sum(r['cover_any'] for r in rows)}/{len(rows)}".ljust(18)
		print(line)

	if args.pairs and len(names) >= 2:
		a, b = names[0], names[1]
		print(f"\n=== {a} vs {b}（只看「沾到」的差异）===")
		win, lose = [], []
		for i in ids:
			ra, rb = arms[a][i], arms[b][i]
			if ra["cover_any"] and not rb["cover_any"]:
				win.append(i)
			elif rb["cover_any"] and not ra["cover_any"]:
				lose.append(i)
		print(f"{a} 有 {b} 没有：{len(win)}  -> {', '.join(win)}")
		print(f"{b} 有 {a} 没有：{len(lose)}  -> {', '.join(lose)}")

		print(f"\n=== 覆盖率差（{a} − {b}，按 class）===")
		for cls in classes:
			rows = [i for i in ids if arms[a][i]["class"] == cls]
			if not rows:
				continue
			ca = sum(arms[a][i]["cover_any"] for i in rows) / len(rows)
			cb = sum(arms[b][i]["cover_any"] for i in rows) / len(rows)
			print(f"{cls:<6} n={len(rows):>3}  {ca * 100:5.1f}%  vs {cb * 100:5.1f}%   {ca - cb:+.1%}")
	return 0


if __name__ == "__main__":
	sys.exit(main())
