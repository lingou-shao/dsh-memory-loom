# -*- coding: utf-8 -*-
"""自然用记忆榜：按子类（X1…X9 / H / Y / Z / N0）拆开看「材料到没到」。

官方把 `X4`（今天到期）单独列一项诊断，因为相似度检索天然找不到「今天是那一天」；
开发集 A 档里 X4 有 13 个，占 X 的 43%，**不能混在 X 的均值里**。

    python bench-22/diag-natural.py bench-22/work/natural-22.jsonl \
        bench-22/work/natural-bm25.jsonl
"""

import argparse
import json
import os
import statistics
import sys

DATA = os.environ.get("BENCH22_DATA") or os.path.join(
	os.path.dirname(os.path.abspath(__file__)), "..", "..", "cmb-2.2", "benchmark-2.2", "dataset"
)


def jl(path):
	with open(path, encoding="utf-8") as fh:
		return [json.loads(line) for line in fh if line.strip()]


def label(path):
	return os.path.basename(path).replace("natural-", "").replace(".jsonl", "")


def main():
	ap = argparse.ArgumentParser()
	ap.add_argument("files", nargs="+")
	args = ap.parse_args()

	key_path = os.path.join(DATA, "natural", "natural-key-dev.jsonl")
	if not os.path.exists(key_path):
		key_path = os.path.join(os.path.expanduser("~"), "Desktop", "cmb-2.2", "benchmark-2.2", "dataset", "natural", "natural-key-dev.jsonl")
	key = {k["id"]: k for k in jl(key_path)}

	arms = {label(p): {r["id"]: r for r in jl(p)} for p in args.files}
	names = list(arms)
	ids = sorted(set.intersection(*[set(v) for v in arms.values()]))
	subs = sorted({key[i]["subtype"] for i in ids}, key=lambda s: (s[0], int(s[1:]) if s[1:].isdigit() else 0))

	print(f"共同探针 {len(ids)} 个\n")
	head = "子类".ljust(6) + "n".rjust(4) + "  " + "".join(n[:16].ljust(18) for n in names)
	print(head)
	for sub in subs:
		rows = [i for i in ids if key[i]["subtype"] == sub]
		line = sub.ljust(6) + str(len(rows)).rjust(4) + "  "
		for name in names:
			any_ = sum(arms[name][i]["cover_any"] for i in rows)
			full = sum(arms[name][i]["cover_full"] for i in rows)
			line += f"{any_}/{full}/{len(rows)}".ljust(18)
		print(line)
	print("\n格式：沾到 / 全中 / n")

	print("\n官方轮次口径（按子类，沾到/n）")
	head = "子类".ljust(6) + "n".rjust(4) + "  " + "".join(n[:16].ljust(18) for n in names)
	print(head)
	for sub in subs:
		rows = [i for i in ids if key[i]["subtype"] == sub]
		line = sub.ljust(6) + str(len(rows)).rjust(4) + "  "
		for name in names:
			ta = sum(1 for i in rows if arms[name][i].get("turn_any"))
			line += f"{ta}/{len(rows)}".ljust(18)
		print(line)

	print("\nX 内部：按子类与间隔")
	for name in names:
		x = [i for i in ids if key[i]["class"] == "X"]
		any_ = sum(arms[name][i]["cover_any"] for i in x)
		print(f"  {name:<16} X 沾到 {any_}/{len(x)} = {any_ / len(x) * 100:.1f}%  token 中位 {statistics.median(arms[name][i]['tokens'] for i in x):.0f}")

	print("\n按 gap_bucket（X 类）")
	buckets = ["0-1", "2-3", "4-7", "8-30", "31-90", "91-180", "-"]
	head = "bucket".ljust(8) + "n".rjust(4) + "  " + "".join(n[:16].ljust(18) for n in names)
	print(head)
	for b in buckets:
		rows = [i for i in ids if key[i].get("gap_bucket") == b and key[i]["class"] == "X"]
		if not rows:
			continue
		line = b.ljust(8) + str(len(rows)).rjust(4) + "  "
		for name in names:
			any_ = sum(arms[name][i]["cover_any"] for i in rows)
			line += f"{any_}/{len(rows)}".ljust(18)
		print(line)
	return 0


if __name__ == "__main__":
	sys.exit(main())
