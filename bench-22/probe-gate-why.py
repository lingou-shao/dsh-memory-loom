# -*- coding: utf-8 -*-
"""事件行的闸门为什么这么硬：把四门判据拆开数，不动 `lib/`。

§123.6 量到 M02 有 136 道题（42.1%）的证据行过不了闸门，且这批题贡献了 M02
零覆盖题的六成（100/167）。但「过不了闸门」有四种成因，改法完全不同：

  A. FTS 压根没命中这一行        → 索引里没有这些字（§123 那条线）
  B. 命中了，但一个二元组都不共享 → 分母改不改都没用
  C. 共享了，但比例不够           → 分母/加权/分档能救
  D. 共享了足够多实词，却因为只走 tailRows 没席位 → 席位预算能救

产品的放宽趟闸门是 `relaxMinOverlap = 0.25`（不是 0.05，§123 的模拟用错了
这个值，那一版过闸率是**偏乐观**的）。闸门后面还有两门旁路，但都只把行送进
`tailRows`（末尾追加），而 `tailRows` 的落地是 `room = max(0, limit - kept)`。

四门判据与产品一一对应：

    containment(query, text) >= guard          ← relaxMinOverlap
    solidHit(query, text, solidOverlap)        ← 共享 >=3 个实词
    rareTokenHit(query, text)                  ← 共享一个 DF<=rareLimit 的实词
    aliasHit(query, aliases)                   ← 别名整词出现在问句里

    python bench-22/probe-gate-why.py --db bench-22/work/db/M02-5413.db --persona M02
"""

import argparse
import json
import os
import statistics
import sys
from collections import Counter
from importlib.machinery import SourceFileLoader

HERE = os.path.dirname(os.path.abspath(__file__))
_lib = SourceFileLoader("bsim", os.path.join(HERE, "probe-body-sim.py")).load_module()
tokens_of = _lib.tokens_of
loose_match = _lib.loose_match
jl = _lib.jl
CJK_RUN = _lib.CJK_RUN
THIN = _lib.THIN

# `solidToken`：整词里只要有一个非虚字就算实词（`lib/index.js:2328`）
def solid_token(tok):
	return any(c not in THIN for c in tok)


def rare_limit(l0_rows):
	"""`dfCeiling(store, id, RARE_DF)`：按 l0 行数等比放大，保留 3 作下限。"""
	return max(3, int(round(l0_rows * 3.0 / 780)))


def containment(needle, hay):
	small = set(tokens_of(needle))
	if not small:
		return 0.0
	large = set(tokens_of(hay))
	return len(small & large) / len(small)


def main():
	ap = argparse.ArgumentParser()
	ap.add_argument("--db", required=True)
	ap.add_argument("--persona", default="M02")
	ap.add_argument("--ctx", default=os.path.join(HERE, "work", "ctx-0279"))
	ap.add_argument("--guard", type=float, default=0.25, help="放宽趟的 relaxMinOverlap（产品 0.25）")
	ap.add_argument("--solid", type=int, default=3, help="solidOverlap")
	ap.add_argument("--limit", type=int, default=0)
	args = ap.parse_args()

	db = os.path.abspath(args.db)
	con = _lib.sqlite3.connect(db)
	l0_rows = con.execute("select count(*) from l0").fetchone()[0]
	rare_cap = rare_limit(l0_rows)

	# 词表频率：`l0_vocab` 是终态快照，而产品运行时看到的是**当时**的表。
	# 库越大 DF 越大，所以这里算出来的「稀有」是**偏严**的——只会低估 rareHit 的作用。
	df = dict(con.execute("select term, doc from l0_vocab").fetchall())

	l0 = {}
	for rid, turn, role, text in con.execute("select id, turn, role, text from l0"):
		l0[rid] = (turn, role, text)
	events = con.execute(
		"select id, title, summary, aliases, l0_from, l0_to, turn_from, turn_to from events"
	).fetchall()
	ev_row = {}
	for eid, title, summary, aliases, f, t, tf, tt in events:
		ev_row[eid] = dict(
			id=eid, text="%s：%s" % (title or "", summary or ""),
			aliases=aliases or "", turns=(tf, tt),
		)
	con.close()

	sys.path.insert(0, _lib.DATA)
	sys.path.insert(0, os.path.join(os.path.dirname(_lib.DATA), "harness"))
	from bench22.release import load_items  # noqa: E402

	items = {r["id"]: r for r in load_items(_lib.DATA)}
	cuts = {r["id"]: r["cutoff_turn"]
		for r in jl(os.path.join(args.ctx, args.persona, "contexts.jsonl"))}

	rows = jl(os.path.join(args.ctx, "ab-turns.jsonl"))
	rows = [dict(r, cutoff_turn=cuts.get(r["id"])) for r in rows if r["id"].startswith(args.persona)]
	if args.limit:
		rows = rows[: args.limit]

	buckets = Counter()
	solid_hist = Counter()
	shared_hist = Counter()
	qlen = []
	detail = []
	cover_by_bucket = {k: [0, 0] for k in ("过闸门", "A_FTS未命中", "B_零共享", "C_比例不够", "D_实词够但仅追加")}

	for r in rows:
		sid = r["id"]
		item = items.get(sid) or {}
		q = item.get("question") or r.get("question") or ""
		cut = r.get("cutoff_turn")
		ev_turns = set(int(t) for t in (r.get("evidence") or []))
		if cut is None or not ev_turns or not q:
			continue

		avail = [e for e in ev_row.values() if e["turns"][1] is not None and e["turns"][1] <= cut]
		gold = [e for e in avail if any(e["turns"][0] <= t <= e["turns"][1] for t in ev_turns)]
		if not gold:
			continue

		expr = loose_match(q, 12)
		if not expr:
			continue
		c2 = _lib.sqlite3.connect("file:%s?mode=ro" % db.replace("\\", "/"), uri=True)
		matched = set(x[0] for x in c2.execute(
			"select rowid from events_fts where events_fts match ?", (expr,)).fetchall())
		c2.close()

		qtok = set(tokens_of(q))
		qsolid = set(t for t in qtok if solid_token(t))
		qlen.append(len(qtok))

		# 每题只看最靠前的那条证据行：判据问题在「一行都进不来」，不在「第几行」
		best = None
		for e in gold:
			hay = e["text"] + " " + e["aliases"]
			shared = qtok & set(tokens_of(hay))
			n_solid = len(qsolid & set(tokens_of(hay)))
			rare = any(t in df and 0 < df[t] <= rare_cap for t in (qsolid & set(tokens_of(hay))))
			contained = len(shared) / max(1, len(qtok))
			rec = dict(ev=e["id"], contained=contained, shared=len(shared),
				solid=n_solid, rare=rare, esize=len(qtok), hit=e["id"] in matched)
			if best is None or (rec["hit"], rec["contained"], rec["solid"]) > \
				(best["hit"], best["contained"], best["solid"]):
				best = rec
		if best is None:
			continue

		if best["contained"] >= args.guard:
			b = "过闸门"
		elif not best["hit"]:
			b = "A_FTS未命中"
		elif best["shared"] == 0:
			b = "B_零共享"
		elif best["solid"] >= args.solid or best["rare"]:
			b = "D_实词够但仅追加"
		else:
			b = "C_比例不够"
		buckets[b] += 1
		solid_hist[min(best["solid"], 6)] += 1
		shared_hist[min(best["shared"], 8)] += 1
		detail.append(dict(id=sid, bucket=b, **best))

	n = sum(buckets.values())
	print("题 %d（%s，有证据轮且截止时证据行可见）· 闸门 guard=%.2f · solidOverlap=%d · rareLimit=%d（l0 %d 行）"
		% (n, args.persona, args.guard, args.solid, rare_cap, l0_rows))
	print()
	print("  %-22s %5s %7s" % ("证据行卡在哪一门", "题数", "占比"))
	for k, v in buckets.most_common():
		print("  %-22s %5d %6.1f%%" % (k, v, 100.0 * v / n))
	print()
	print("  问句二元组数：中位 %.0f · p25 %.0f · p90 %.0f" % (
		statistics.median(qlen), sorted(qlen)[len(qlen) // 4], sorted(qlen)[int(len(qlen) * 0.9)]))
	print("  共享二元组数分布（证据行 ∩ 问句）：", dict(sorted(shared_hist.items())))
	print("  共享实词数分布（>=6 合桶）：      ", dict(sorted(solid_hist.items())))
	print()
	# 覆盖率的归属
	cov = {r["id"]: r for r in rows}
	for d in detail:
		c = cov.get(d["id"], {})
		ok = c.get("cov_union", 0) >= 1.0
		cover_by_bucket[d["bucket"]][1] += 1
		if ok:
			cover_by_bucket[d["bucket"]][0] += 1
	print("  各门在真实产品里的满覆盖率（cov_union >= 1）：")
	for k, (a, b) in sorted(cover_by_bucket.items(), key=lambda kv: -kv[1][1]):
		if b:
			print("    %-22s %3d/%3d = %5.1f%%" % (k, a, b, 100.0 * a / b))

	out = os.path.join(HERE, "work", "gate-why-%s.jsonl" % args.persona)
	with open(out, "w", encoding="utf-8") as fh:
		for d in detail:
			fh.write(json.dumps(d, ensure_ascii=False) + "\n")
	print()
	print("  逐题产物 %s" % os.path.relpath(out, os.path.dirname(HERE)))


if __name__ == "__main__":
	main()
