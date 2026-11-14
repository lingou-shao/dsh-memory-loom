# -*- coding: utf-8 -*-
"""「最近六轮」值不值：收益是几题，代价是几个字（§116）。

BM25 基线（`bm25-recent6`）的 16 个槽里有 **6 个无条件给最近六轮**，这不看问句、
不看相关性。我们的产品没有这条通道——真实会话里最近几轮通常在宿主上下文里，插件
不重复搬一遍是有意的。所以这不是「补一个 bug」，是「要不要为一类题付一笔常数」。

两件事分开量，因为它们的量纲不同：

  收益  证据轮落在 [截止-6, 截止) 的题里，有哪几题现在**没**覆盖
  代价  这六轮的原话字数，**每题都付**（不管有没有因此变好），已经在 `used_turns`
        里的不重复付费

净收益用同一把尺子读：`现覆盖 ∪ 最近六轮` 对 `现覆盖`。

    python bench-22/recency-22.py --rank bench-22/work/rank-0278.jsonl
"""

import argparse
import json
import math
import os
import statistics

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get("BENCH22_DATA") or os.path.join(
	os.path.expanduser("~"), "Desktop", "cmb-2.2", "benchmark-2.2", "dataset"
)
TOKENS_PER_CHAR = 0.237
RECENT = 6
# 每题记忆文本的中位字数（§113.4：M01 2,387 / M02 3,380），用来把「多几个字」折成 C。
BASE_CHARS = {"M01": 2387.0, "M02": 3380.0}


def load_hist(persona):
	path = os.path.join(DATA, "histories", "%s.jsonl" % persona)
	if not os.path.exists(path):
		return {}
	return {int(r["轮次"]): r for r in (json.loads(l) for l in open(path, encoding="utf-8") if l.strip())}


def main():
	ap = argparse.ArgumentParser()
	ap.add_argument("--rank", default=os.path.join(HERE, "work", "rank-0278.jsonl"))
	ap.add_argument("--recent", type=int, default=RECENT)
	ap.add_argument("--user-only", action="store_true", help="只搬用户那半边")
	ap.add_argument("--clip", type=int, default=0, help="每半边截到多少字；0 = 不截")
	args = ap.parse_args()

	rows = [json.loads(line) for line in open(args.rank, encoding="utf-8") if line.strip()]
	hist = {"M01": load_hist("M01"), "M02": load_hist("M02")}

	print(f"{'套':<6}{'题':>5}{'现覆盖':>9}{'加六轮':>9}{'净增':>7}{'每题字数':>10}{'每题token':>10}")
	summary = {}
	for persona in ("M01", "M02", "全部"):
		sub = rows if persona == "全部" else [r for r in rows if r["persona"] == persona]
		sub = [r for r in sub if r["ev"]]
		n = now = after = 0
		costs = []
		for r in sub:
			n += 1
			ev = set(r["ev"])
			got = set()
			for one in r.get("loom10") or r["loom"]["10"]:
				got |= set(one["turns"])
			recent = set(range(max(0, r["cutoff"] - args.recent), r["cutoff"]))
			now += bool(ev & got)
			after += bool(ev & (got | recent))
			added = 0
			for turn in sorted(recent - got):
				row = hist.get(r["persona"], {}).get(turn)
				if row is None:
					continue
				user = str(row.get("用户消息") or "")
				reply = "" if args.user_only else str(row.get("助手回复") or "")
				if args.clip > 0:
					user, reply = user[: args.clip], reply[: args.clip]
				added += len(user) + len(reply)
			costs.append(added)
		mean_cost = statistics.mean(costs) if costs else 0.0
		print(f"{persona:<6}{n:>5}{now/n*100:>8.1f}%{after/n*100:>8.1f}%"
		      f"{(after-now)/n*100:>+6.1f}{mean_cost:>10.0f}{mean_cost*TOKENS_PER_CHAR:>10.0f}")
		summary[persona] = dict(n=n, now=now, after=after, chars=mean_cost)

	print("\n代价折成分（C 涨的比例 = 每题新增字数 / 现记忆文本字数）")
	for persona in ("M01", "M02"):
		one = summary[persona]
		f = 1 + one["chars"] / BASE_CHARS[persona]
		print(f"  {persona}: +{one['chars']:.0f} 字 = 现记忆文本的 {one['chars']/BASE_CHARS[persona]*100:.1f}%，"
		      f"ΔS = {-3*math.log2(f):+.2f}")


if __name__ == "__main__":
	main()
