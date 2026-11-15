# -*- coding: utf-8 -*-
"""「返回了但在后面」到底是怎么个在后面：把金标行分成三档数。

`ab-turns.py` 的 `cov_union` 是**轮次级**的：那一轮以任何形式出现过就算覆盖。
但提示词给模型的东西差一个量级：

  L1 全文   证据轮被展开成【原话】块（`EXPANDS=2`，只有前两个编号摊开）
  L2 钩子   只在「检索到的记忆」列表里：一行摘要，或 `rawPreview=60` 字的截断预览
  L0 缺席   连列表都不在

所以覆盖率是**可达上界**，不是模型真能读到的比例。这个脚本把每一题的金标行按
三档归类，并且把 L2 再拆成「摘要行 #E/#F」和「截断原话 #L」。

    python bench-22/probe-tier.py --ctx work/ctx-0279 --db work/db/M02-5413.db --persona M02
"""

import argparse
import json
import os
import re
import sqlite3
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))

REF = re.compile(r"#([FEPL]\d+(?:-\d+)?)")
HEAD = re.compile(r"【正文 · (#[FEPL]\d+(?:-\d+)?)")
LSPAN = re.compile(r"^L(\d+)(?:-(\d+))?$")


def jl(path):
	with open(path, encoding="utf-8") as fh:
		return [json.loads(line) for line in fh if line.strip()]


def sections(prompt):
	"""列表段的编号顺序、展开段的编号集合。"""
	tail = prompt.split("【检索到的记忆】", 1)
	if len(tail) < 2:
		return [], set()
	rest = tail[1]
	cut = rest.find("\n\n【原话】")
	listing = rest if cut < 0 else rest[:cut]
	order = []
	for one in REF.findall(listing):
		if one not in order:
			order.append(one)
	return order, set(HEAD.findall(prompt))


def span_of(ref):
	m = LSPAN.match(ref)
	if not m:
		return None
	a = int(m.group(1))
	return (a, int(m.group(2) or a))


def main():
	ap = argparse.ArgumentParser()
	ap.add_argument("--ctx", default=os.path.join(HERE, "work", "ctx-0279"))
	ap.add_argument("--db", default=os.path.join(HERE, "work", "db", "M02-5413.db"))
	ap.add_argument("--persona", default="M02")
	ap.add_argument("--dump", default="")
	args = ap.parse_args()

	con = sqlite3.connect(os.path.abspath(args.db))
	ev, fact = {}, {}
	for eid, f, t in con.execute("select id, l0_from, l0_to from events"):
		ev["E%s" % eid] = (f, t)
	for fid, src in con.execute("select id, source_ids from facts"):
		if not src:
			continue
		try:
			ids = json.loads(src)
		except Exception:  # noqa: BLE001
			continue
		if ids:
			fact["F%s" % fid] = (min(ids), max(ids))
	con.close()

	gold = {r["id"]: r for r in jl(os.path.join(HERE, "work", "gate-why-%s.jsonl" % args.persona))}
	cov = {r["id"]: r.get("cov_union", 0) for r in jl(os.path.join(args.ctx, "ab-turns.jsonl"))}
	rows = [r for r in jl(os.path.join(args.ctx, args.persona, "contexts.jsonl")) if r["id"] in gold]

	tab = defaultdict(Counter)
	rank_hist = Counter()
	by_level = defaultdict(lambda: [0, 0])
	size_hist = Counter()
	detail = []

	for row in rows:
		g = gold[row["id"]]
		order, expanded = sections(row["prompt"])
		size_hist[len(order)] += 1

		raw = g.get("ev")
		key = "E%s" % raw if isinstance(raw, int) else str(raw)
		span = ev.get(key) or fact.get(key)

		lv, rank, kind = 0, None, ""
		if span is not None:
			want = "#" + key
			for i, ref in enumerate(order):
				match = "#" + ref == want
				s = span_of(ref)
				if not match and s is not None:
					match = not (s[1] < span[0] or s[0] > span[1])
				if match:
					rank = i + 1
					if "#" + ref in expanded or want in expanded:
						lv = 1
					else:
						lv = 2
						kind = ref[0]
					break

		tab[g["bucket"]][lv] += 1
		if rank:
			rank_hist[min(rank, 10)] += 1
		ok = cov.get(row["id"], 0) >= 1.0
		by_level[lv][1] += 1
		by_level[lv][0] += ok
		detail.append(dict(id=row["id"], bucket=g["bucket"], level=lv, rank=rank, cov=ok, kind=kind))

	names = {0: "L0 连列表都没进", 1: "L1 展开成全文", 2: "L2 只有一行钩子"}
	print("%s · %d 题（有证据行且截止时可见）" % (args.persona, len(rows)))
	print()
	print("  %-26s %5s %8s %8s %8s" % ("分桶", "题数", "L1 全文", "L2 钩子", "L0 缺席"))
	for b, c in sorted(tab.items(), key=lambda kv: -sum(kv[1].values())):
		tot = sum(c.values())
		print("  %-26s %5d %7.1f%% %7.1f%% %7.1f%%" % (
			b, tot, 100.0 * c[1] / tot, 100.0 * c[2] / tot, 100.0 * c[0] / tot))
	tc = Counter()
	for c in tab.values():
		tc.update(c)
	tot = sum(tc.values())
	print("  %-26s %5d %7.1f%% %7.1f%% %7.1f%%" % (
		"合计", tot, 100.0 * tc[1] / tot, 100.0 * tc[2] / tot, 100.0 * tc[0] / tot))
	print()
	print("  金标行名次（只数进列表的）：")
	for k in sorted(rank_hist):
		print("    第 %2d 名 %4d  %s" % (k, rank_hist[k], "#" * (rank_hist[k] // 4)))
	print()
	print("  三档的实际满覆盖率（cov_union >= 1）：")
	for lv in (1, 2, 0):
		a, b = by_level[lv]
		if b:
			print("    %-16s %3d/%3d = %5.1f%%" % (names[lv], a, b, 100.0 * a / b))
	kc = Counter(d["kind"] for d in detail if d["level"] == 2)
	print("  L2 里是哪种行：", {"#E/#F 摘要": kc["E"] + kc["F"], "#L 六十字预览": kc["L"], "#P": kc["P"]})
	print()
	print("  列表行数分布：", dict(sorted(size_hist.items())))

	if args.dump:
		with open(args.dump, "w", encoding="utf-8") as fh:
			for d in detail:
				fh.write(json.dumps(d, ensure_ascii=False) + "\n")
		print("  逐题 -> %s" % os.path.abspath(args.dump))


if __name__ == "__main__":
	main()
