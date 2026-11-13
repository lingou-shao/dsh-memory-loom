# -*- coding: utf-8 -*-
"""自然榜「跑一遍 33 分钟」到底花在哪（2026-11-13）。

`probe_natural.py` 的日志只报「每题/每 5 题」的累计秒数，看不出**单项**的
成本形状。它有两种完全不同的成因，读数长得一样：

- **线性**：M02 的语料本来就比 M01 长三倍，0.26 s/轮 vs 0.089 s/轮，没毛病；
- **超线性**：某些东西按行数退化（§93 的 CROSS JOIN、§100.11 的到期游标），
  那每轮成本会随已灌轮数往上走，越跑越慢。

区分办法是**按库规模采样单项**，而不是看每题的合计：一题里既有灌入（随 pos
增长的量），也有 mark/rewind（随库大小增长的量），合计把它们混在一起。

    python bench-22/probe-run-cost.py [--persona M02] [--turns 2500] [--step 250]

只读产品接口（`loom_system.LoomSystem`），不改 `lib/`。
"""

import argparse
import json
import os
import statistics
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))


def _pick(env, *parts):
	for root in (os.environ.get(env), os.path.join(HERE, "..", "..", "cmb-2.2"), os.path.join(os.path.expanduser("~"), "Desktop", "cmb-2.2")):
		if root and os.path.isdir(os.path.join(root, *parts)):
			return os.path.abspath(os.path.join(root, *parts))
	return os.path.abspath(os.path.join(*parts))


HARNESS = _pick("BENCH22_HARNESS", "benchmark-2.2", "harness")
DATA = _pick("BENCH22_DATA", "benchmark-2.2", "dataset")
sys.path.insert(0, HARNESS)
sys.path.insert(0, HERE)

from loom_system import LoomSystem  # noqa: E402


def jl(path):
	with open(path, encoding="utf-8") as fh:
		return [json.loads(line) for line in fh if line.strip()]


def main():
	ap = argparse.ArgumentParser()
	ap.add_argument("--persona", default="M02")
	ap.add_argument("--turns", type=int, default=2500)
	ap.add_argument("--step", type=int, default=250)
	ap.add_argument("--head", type=int, default=0, help="先直接灌到第 N 轮再开始采样（跳过预热）")
	args = ap.parse_args()

	hist = jl(os.path.join(DATA, "histories", f"{args.persona}.jsonl"))
	hist = hist[: args.turns]
	print(f"{args.persona}: {len(hist)} 轮，每 {args.step} 轮采一次", flush=True)

	system = LoomSystem()
	system.sid = args.persona
	# 语料字数：线性 vs 超线性的第一件事是看每轮喂进去多少字
	chars = sum(len(r["用户消息"]) + len(r["助手回复"]) for r in hist)
	print(f"  语料 {chars:,} 字，平均 {chars / len(hist):.0f} 字/轮", flush=True)

	rows = []
	pos = 0
	seg_t0 = time.time()
	while pos < len(hist):
		stop = min(pos + args.step, len(hist))
		while pos < stop:
			row = hist[pos]
			system.ingest({"turn": row["轮次"], "time": row["逻辑时间"], "user": row["用户消息"], "assistant": row["助手回复"]})
			pos += 1
		ingest_s = time.time() - seg_t0

		# mark：整库 VACUUM INTO
		t0 = time.time()
		tok = system.mark()
		mark_s = time.time() - t0

		# 一题的尾巴：两轮新语料
		t0 = time.time()
		seq = pos
		for tt in hist[max(0, pos - 2) : pos]:
			seq += 1
			system.ingest({"turn": seq, "time": tt["逻辑时间"], "user": tt["用户消息"], "assistant": tt["助手回复"]})
		tail_s = time.time() - t0

		# 取面：常驻块 + 检索 + 两次展开
		t0 = time.time()
		system.retrieve(hist[pos - 1]["用户消息"], hist[pos - 1]["逻辑时间"], seq)
		ret_s = time.time() - t0

		# 回退：还原快照 + 重建实例
		t0 = time.time()
		system.rewind(tok)
		rew_s = time.time() - t0

		st = system.client.rpc("stat")
		rows.append(
			{
				"turn": pos,
				"rows": st["rows"],
				"ingest_s": round(ingest_s, 2),
				"per_turn_ms": round(ingest_s / args.step * 1000, 1),
				"mark_s": round(mark_s, 3),
				"tail_s": round(tail_s, 2),
				"ret_s": round(ret_s, 3),
				"rew_s": round(rew_s, 3),
			}
		)
		r = rows[-1]
		print(
			f"  {r['turn']:>5} 轮  l0 {r['rows']:>6} 行 | 灌 {r['ingest_s']:>6.1f}s ({r['per_turn_ms']:>5.1f} ms/轮)"
			f" | mark {r['mark_s']:>5.2f}s | tail {r['tail_s']:>5.2f}s | 取面 {r['ret_s']:>5.2f}s | 回退 {r['rew_s']:>5.2f}s",
			flush=True,
		)
		seg_t0 = time.time()

	system.close()

	print("\n=== 形状 ===")
	first, last = rows[0], rows[-1]
	print(f"  每轮灌入：{first['per_turn_ms']:.1f} → {last['per_turn_ms']:.1f} ms（×{last['per_turn_ms'] / first['per_turn_ms']:.2f}）")
	print(f"  mark：    {first['mark_s']:.2f} → {last['mark_s']:.2f} s（×{last['mark_s'] / max(first['mark_s'], 1e-6):.2f}）")
	print(f"  回退：    {first['rew_s']:.2f} → {last['rew_s']:.2f} s（×{last['rew_s'] / max(first['rew_s'], 1e-6):.2f}）")
	print(f"  取面：    {first['ret_s']:.2f} → {last['ret_s']:.2f} s（×{last['ret_s'] / max(first['ret_s'], 1e-6):.2f}）")
	per_turn = [r["per_turn_ms"] for r in rows]
	print(f"  每轮灌入 中位 {statistics.median(per_turn):.1f} ms，后半/前半 = {statistics.median(per_turn[len(per_turn) // 2:]) / statistics.median(per_turn[: max(1, len(per_turn) // 2)]):.2f}")
	with open(os.path.join(HERE, "work", f"cost-{args.persona}.json"), "w", encoding="utf-8") as fh:
		json.dump(rows, fh, ensure_ascii=False, indent=1)


if __name__ == "__main__":
	main()
