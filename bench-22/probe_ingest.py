# -*- coding: utf-8 -*-
"""量「把整个历史灌进库」要多久、库多大。

这不是读数，是工程可行性：封存跑里评测程序会把每个榜的整段历史一轮一轮喂进来，
一次（`runner.py` 按 cutoff 升序访问，所以整卷只灌一遍）。如果 7000 轮要一小时，
方案就得改；如果是十分钟，就按现在这个走。

    python bench-22/probe_ingest.py [--persona M01] [--limit 0]

不花钱、不需要网关：只跑产品自己的写入路径。
"""

import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
HARNESS = os.environ.get(
	"BENCH22_HARNESS", os.path.join(HERE, "..", "..", "cmb-2.2", "benchmark-2.2", "harness")
)
sys.path.insert(0, os.path.abspath(HARNESS))
sys.path.insert(0, HERE)

from loom_system import LoomSystem, _ms  # noqa: E402

DATA = os.environ.get(
	"BENCH22_DATA", os.path.join(HERE, "..", "..", "cmb-2.2", "benchmark-2.2", "dataset")
)


def main():
	persona = "M01"
	limit = 0
	args = sys.argv[1:]
	for i, a in enumerate(args):
		if a == "--persona":
			persona = args[i + 1]
		if a == "--limit":
			limit = int(args[i + 1])

	rows = []
	with open(os.path.join(DATA, "histories", f"{persona}.jsonl"), encoding="utf-8") as fh:
		for line in fh:
			if line.strip():
				rows.append(json.loads(line))
	if limit:
		rows = rows[:limit]

	system = LoomSystem()
	system.sid = persona
	print(f"{persona}: {len(rows)} 轮", flush=True)
	start = time.time()
	last = start
	for i, row in enumerate(rows):
		system.ingest(
			{
				"turn": row["轮次"],
				"time": row["逻辑时间"],
				"user": row["用户消息"],
				"assistant": row["助手回复"],
			}
		)
		if (i + 1) % 500 == 0:
			now = time.time()
			print(f"  {i + 1} 轮  本段 {now - last:.1f}s  累计 {now - start:.1f}s", flush=True)
			last = now
	total = time.time() - start
	stat = system.client.rpc("stat")
	size = os.path.getsize(system.client.db) / 1024 / 1024
	print(f"完成 {len(rows)} 轮，{total:.1f}s（{total / max(1, len(rows)) * 1000:.0f} ms/轮）", flush=True)
	print(f"l0 {stat['rows']} 行，库 {size:.1f} MB", flush=True)
	system.close()
	return 0


if __name__ == "__main__":
	sys.exit(main())
