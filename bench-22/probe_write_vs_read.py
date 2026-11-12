# -*- coding: utf-8 -*-
"""在同一份库上，量「只写入」和「写入 + 取面」的每轮代价差多少。

2.2 的取面脚本实测 M02 到了 1.7–2.3 s/轮，而同样语料单独灌库只要 80–130 ms/轮。
差的那十几倍要么在 RPC，要么在「取面时反复新开只读连接」——后者会打断 WAL 的
检查点节奏，让下一次写入重新铺页。这里把两者分开：

    python bench-22/probe_write_vs_read.py --db <30MB 左右的库> [--rounds 60]

A 段：只有 turn。
B 段：每 10 轮做一次完整的取面（block + search + expands + sources + usedTurns）。
"""

import argparse
import json
import os
import shutil
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
HARNESS = os.environ.get(
	"BENCH22_HARNESS", os.path.join(HERE, "..", "..", "cmb-2.2", "benchmark-2.2", "harness")
)
sys.path.insert(0, os.path.abspath(HARNESS))
sys.path.insert(0, HERE)

from loom_system import LoomClient  # noqa: E402

DATA = os.environ.get(
	"BENCH22_DATA", os.path.join(HERE, "..", "..", "cmb-2.2", "benchmark-2.2", "dataset")
)
TEXT = "今天下班路上又下雨了，我站在便利店门口等了好久，伞忘在工位上了，最后是跑回去的。" * 2


def main():
	ap = argparse.ArgumentParser()
	ap.add_argument("--db", required=True)
	ap.add_argument("--rounds", type=int, default=60)
	ap.add_argument("--persona", default="M02")
	args = ap.parse_args()

	work = tempfile.mkdtemp(prefix="loom-wr-")
	copy = os.path.join(work, "loom.db")
	shutil.copyfile(args.db, copy)
	for suffix in ("-wal", "-shm"):
		if os.path.exists(args.db + suffix):
			shutil.copyfile(args.db + suffix, copy + suffix)

	client = LoomClient(db=copy, work_dir=work)
	base = 1756700000000

	def feed(n, tag):
		t0 = time.time()
		for i in range(n):
			client.rpc("turn", sid=args.persona, user=TEXT, assistant="嗯，下次记得带伞。", at=base + i * 60000)
		ms = (time.time() - t0) / n * 1000
		print(f"{tag}: {n} 轮，{ms:.0f} ms/轮", flush=True)
		return ms

	a = feed(args.rounds, "A 只写入")

	t0 = time.time()
	for i in range(10):
		client.rpc("turn", sid=args.persona, user=TEXT, assistant="嗯，下次记得带伞。", at=base + 999999 + i * 60000)
		block = client.rpc("block", sid=args.persona, now=base + 999999 + i * 60000)["text"]
		search = client.rpc("search", sid=args.persona, query="我伞忘哪了", limit=10, now=base)["text"]
		lines = [
			line[2:].strip()
			for line in block.splitlines()
			if line.startswith("- ") and len(line) > 6
		][:12]
		client.rpc("sources", sid=args.persona, lines=lines)
		client.rpc("usedTurns", sid=args.persona, spans=[[1, 20]])
	ms = (time.time() - t0) / 10 * 1000
	print(f"B 写入+取面：10 轮，{ms:.0f} ms/轮（含 1 次取面）", flush=True)
	print(f"   → 写入本身约 {a:.0f} ms/轮，多出来的是 {(ms - a):.0f} ms/轮", flush=True)
	client.close()
	print(f"工作目录 {work}")
	return 0


if __name__ == "__main__":
	sys.exit(main())
