# -*- coding: utf-8 -*-
"""自然榜的一题到底花在哪（2026-11-12：「怎么这么久」）。

76 题跑 43 分钟不是检索慢——是**入库**：M01 的历史到 6874 轮、M02 到 5116 轮，
一次全量重放要灌一万两千轮。这里把一段重放拆成四段计时，别再靠猜：

    python bench-22/probe-natural-cost.py [--turns 300]

输出（每轮毫秒）：灌一轮 / mark 快照 / 取面（块+检索+展开）/ rewind / 查询轮次。
"""

import argparse
import json
import os
import re
import statistics
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))


def _pick(env, *parts):
	cands = []
	if os.environ.get(env):
		cands.append(os.environ[env])
	cands.append(os.path.join(HERE, "..", "..", "cmb-2.2", *parts))
	cands.append(os.path.join(os.path.expanduser("~"), "Desktop", "cmb-2.2", *parts))
	for c in cands:
		if os.path.isdir(c):
			return os.path.abspath(c)
	return os.path.abspath(cands[-1])


HARNESS = _pick("BENCH22_HARNESS", "benchmark-2.2", "harness")
DATA = _pick("BENCH22_DATA", "benchmark-2.2", "dataset")
sys.path.insert(0, HARNESS)
sys.path.insert(0, HERE)

from loom_system import LoomSystem  # noqa: E402


def main():
	ap = argparse.ArgumentParser()
	ap.add_argument("--turns", type=int, default=300)
	ap.add_argument("--persona", default="M01")
	args = ap.parse_args()

	hist = [
		{"turn": r["轮次"], "time": r["逻辑时间"], "user": r["用户消息"], "assistant": r["助手回复"]}
		for r in (json.loads(line) for line in open(os.path.join(DATA, "histories", f"{args.persona}.jsonl"), encoding="utf-8") if line.strip())
	]
	todo = hist[: args.turns]
	print(f"{args.persona}: {len(todo)} 轮（历史共 {len(hist)} 轮）")

	system = LoomSystem()
	system.sid = args.persona
	ingest = []
	t0 = time.time()
	for row in todo:
		a = time.perf_counter()
		system.ingest(row)
		ingest.append((time.perf_counter() - a) * 1000)
	wall = time.time() - t0

	a = time.perf_counter()
	tok = system.mark()
	mark_ms = (time.perf_counter() - a) * 1000

	probe = "上次说的那件事后来怎么样了"
	now = todo[-1]["time"]
	a = time.perf_counter()
	ret = system.retrieve(probe, now, todo[-1]["turn"], item_id="cost")
	take_ms = (time.perf_counter() - a) * 1000

	a = time.perf_counter()
	system.rewind(tok)
	rewind_ms = (time.perf_counter() - a) * 1000

	a = time.perf_counter()
	st = system.client.rpc("stat")
	stat_ms = (time.perf_counter() - a) * 1000

	total = sum(ingest) / 1000 + (mark_ms + take_ms + rewind_ms + stat_ms) / 1000
	print(f"  灌一轮     中位 {statistics.median(ingest):6.1f} ms  合计 {sum(ingest) / 1000:6.1f} s  ({len(ingest)} 轮)")
	print(f"  mark        {mark_ms:6.1f} ms   （VACUUM INTO 整库快照）")
	print(f"  取面        {take_ms:6.1f} ms   （块 + 检索 + 2 次展开 + 轮次反查）")
	print(f"  rewind      {rewind_ms:6.1f} ms   （拷回快照 + 重建实例）")
	print(f"  stat        {stat_ms:6.1f} ms")
	print(f"  ---- 合计 {total:6.1f} s，其中入库占 {sum(ingest) / 1000 / total * 100:.0f}%")
	print(f"  l0 {st['rows']} 行，提示词 {len(ret.prompt)} 字 / {round(len(ret.prompt) * 0.7)} token")
	print(f"  按这个速度：76 题（M01 到 6874 轮 + M02 到 5116 轮）≈ {(6874 + 5116) * statistics.median(ingest) / 1000 / 60:.0f} 分钟")


if __name__ == "__main__":
	main()
