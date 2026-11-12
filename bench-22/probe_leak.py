# -*- coding: utf-8 -*-
"""泄漏哨兵的正对照：故意让它看见未来，确认那两条臂会响。

官方的 `--sentinel --leaky` 是先整卷入库、再按各点截止轮取面，两个人跑一遍要 80 分钟。
这里做的是**同一件事的最小版**：截前 `--turns` 轮入库，在第 `turns + 1` 轮埋一个金丝雀
（把问句原文复述一遍 + 一个 nonce），然后在 cutoff = turns 上取面。此时金丝雀**在库里**：

- 字符串臂：nonce 必须出现在提示词里；
- 轮次臂：`used_turns` 必须出现 > cutoff 的轮次。

两条都响，才说明 §92.4 那个「0/24 clean」不是空转。

    python bench-22/probe_leak.py --persona M01 --turns 40
"""

import argparse
import json
import os
import sys

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
NONCE = "CANARY-leakcontrol-7f3a"


def main():
	ap = argparse.ArgumentParser()
	ap.add_argument("--persona", default="M01")
	ap.add_argument("--turns", type=int, default=40)
	args = ap.parse_args()

	with open(os.path.join(DATA, "histories", f"{args.persona}.jsonl"), encoding="utf-8") as fh:
		rows = [json.loads(line) for line in fh if line.strip()]
	rows = rows[: args.turns + 1]

	system = LoomSystem()
	system.sid = args.persona
	for i, row in enumerate(rows):
		user = row["用户消息"]
		assistant = row["助手回复"]
		if i == args.turns:  # 截止轮之后那一轮：埋金丝雀
			user = user + f" （{NONCE}）"
			assistant = f"好的，记下了 {NONCE}。" + user
		system.ingest({"turn": row["轮次"], "time": row["逻辑时间"], "user": user, "assistant": assistant})

	# 用金丝雀那一轮的问句去问，截止轮是它的前一轮：字面检索必然命中那条尾巴
	canary = rows[args.turns]
	question = canary["用户消息"]
	ret = system.retrieve(question, canary["逻辑时间"], args.turns, "LEAK-CONTROL")
	system.close()

	seen_text = NONCE in ret.prompt
	seen_turn = [t for t in ret.used_turns if t > args.turns]
	ok = seen_text and bool(seen_turn)
	print(f"persona {args.persona}  截止轮 {args.turns}  金丝雀在 {args.turns + 1}")
	print(f"  字符串臂：nonce {'命中' if seen_text else '未命中'}（提示词 {len(ret.prompt)} 字）")
	print(f"  轮次臂：used_turns > 截止轮的 {seen_turn or '无'}")
	print(("正对照成立：两条臂都会报" if ok else "正对照失败：哨兵是空转"))
	return 0 if ok else 1


if __name__ == "__main__":
	sys.exit(main())
