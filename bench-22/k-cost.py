# -*- coding: utf-8 -*-
"""容量（k）的收益与代价，以及「多给几席」和「排得准」的分账。

`probe-rank.py` 在同一道题的同一个截止轮上问 k=10/20/30/50 四次，把每条返回的
`#F/#E/#L` 解回来源轮。这个脚本读那份产物，回答三件事：

1. **金标轮在不在前 k 条里**（逐 k、逐套）；
2. **置换对照**：从 k=50 那批里**随机**抽 k 条，覆盖是多少。随机抽样保留了「席位
   数」、去掉了「排序」，所以：

     随机 k 的覆盖 ≈ k=10 的覆盖  → 涨的那部分来自「多给几条」，不来自「排得准」
     随机 k 的覆盖 << k 的覆盖     → 排序本身在起作用，加席位是放大它

   这一条是外部那份验收计划里的 A5（`1.1.zip` · `semanticControl=permute`）在
   我们这里的对应物：**它不问「有没有用」，只问「用处是哪一种」**。对我们的决定
   同样关键——如果是前一种，加 k 只是把噪声端出去，还会推高 C。

3. **代价**：检索段字符数随 k 的增长，折成 token 与 S 分。

    S 的成本项是 `min(6, -3·log2(C / C_ref))`，C 是记忆文本的 token 数。
    字符涨 f 倍 → ΔS = -3·log2(f)，与库、与题目都无关。

    python bench-22/k-cost.py --rank bench-22/work/rank-ks.jsonl
"""

import argparse
import json
import math
import os
import random
import statistics

HERE = os.path.dirname(os.path.abspath(__file__))
# 一个汉字按 0.237 token 折（§112 实测：2,391 字 → 567 token）。
TOKENS_PER_CHAR = 0.237
# M01 / M02 现有的 C 比值（对参照系统），用来算「涨了之后掉几分」。
C_RATIO = {"M01": 0.448, "M02": 0.148, "全部": 0.448}
# 每题记忆文本的中位字数（§113.4）：常驻块 + 检索行 + 两次展开，不含前言。
BASE_TEXT = {"M01": 2387.0, "M02": 3380.0}


def union(rows):
	out = set()
	for one in rows:
		out |= set(one["turns"])
	return out


def main():
	ap = argparse.ArgumentParser()
	ap.add_argument("--rank", default=os.path.join(HERE, "work", "rank-ks.jsonl"))
	ap.add_argument("--seed", type=int, default=20261114)
	ap.add_argument("--draws", type=int, default=20)
	args = ap.parse_args()

	rows = [json.loads(line) for line in open(args.rank, encoding="utf-8") if line.strip()]
	rows = [r for r in rows if r["ev"]]
	if not rows:
		raise SystemExit("没有带证据轮的题")
	# 老产物（0.2.78 的 rank-0278.jsonl）只有 loom10 / loom50 两个字段，没有 loom 字典。
	if "loom" in rows[0]:
		ks = sorted(int(k) for k in rows[0]["loom"])
	else:
		ks = sorted(int(k[4:]) for k in rows[0] if k.startswith("loom") and k[4:].isdigit())

	def got(r, k):
		if "loom" in r:
			return r["loom"][str(k)]
		return r.get("loom%d" % k, [])

	def chars(r, k):
		if "chars" in r:
			return r["chars"].get(str(k), 0)
		return 0
	top = max(ks)
	rng = random.Random(args.seed)

	print(f"题 {len(rows)}（M01 {sum(1 for r in rows if r['persona']=='M01')} · "
	      f"M02 {sum(1 for r in rows if r['persona']=='M02')}）· k = {ks}")

	print(f"\n{'套':<6}{'k':>4}{'命中':>8}{'命中率':>9}{'随机对照':>10}{'差':>8}"
	      f"{'检索段字数':>11}{'折 token':>9}")
	base_chars = {}
	for persona in ("M01", "M02", "全部"):
		sub = rows if persona == "全部" else [r for r in rows if r["persona"] == persona]
		if not sub:
			continue
		for k in ks:
			hit = 0
			ctrl = 0.0
			ch = []
			for r in sub:
				ev = set(r["ev"])
				rows_k = got(r, k)
				if ev & union(rows_k):
					hit += 1
				ch.append(chars(r, k))
				pool = got(r, top)
				if len(pool) > k:
					trials = 0
					for _ in range(args.draws):
						if ev & union(rng.sample(pool, k)):
							trials += 1
					ctrl += trials / args.draws
				elif ev & union(pool):
					ctrl += 1
			n = len(sub)
			mean_chars = statistics.mean(ch)
			if k == ks[0]:
				base_chars[persona] = mean_chars
			print(f"{persona:<6}{k:>4}{hit:>8}{hit/n*100:>8.1f}%{ctrl/n*100:>9.1f}%"
			      f"{(hit-ctrl)/n*100:>+7.1f}{mean_chars:>11.0f}{mean_chars*TOKENS_PER_CHAR:>9.0f}")

	# C 的**分母是整段记忆文本**，不是检索段：常驻块、检索行、展开的原话都在里面。
	# 拿检索段的涨幅当 C 的涨幅会高估 2–3 倍（§118.2 记的就是这个错）。这里用
	# §113.4 量的每题记忆文本中位字数当基数，只把检索段的增量加进去。
	print("\n代价（C 用整段记忆文本做分母；ΔS 只与总涨幅有关）")
	print(f"{'套':<6}{'k':>4}{'检索段':>9}{'总文本':>9}{'涨幅':>8}{'ΔS':>8}")
	for persona in ("M01", "M02"):
		sub = [r for r in rows if r["persona"] == persona]
		if not sub:
			continue
		base = statistics.mean(chars(r, ks[0]) for r in sub)
		for k in ks:
			one = statistics.mean(chars(r, k) for r in sub)
			total = BASE_TEXT[persona] + (one - base)
			f = total / BASE_TEXT[persona]
			ds = -3 * math.log2(f)
			print(f"{persona:<6}{k:>4}{one:>9.0f}{total:>9.0f}{(f-1)*100:>+7.1f}%{ds:>+7.2f}")


if __name__ == "__main__":
	main()
