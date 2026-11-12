# -*- coding: utf-8 -*-
"""两臂逐题比对：在**同一把（修好的）尺子**上，列出只在一侧沾到的题。

    python bench-22/diff-cover.py work/natural-22-v6.jsonl work/natural-22-v12.jsonl

为什么不用 `compare-natural.py`：那个脚本读的是产物里**当时记下**的 `cover_any`，
尺子改了以后它比的是两次不同尺子的读数。这里一律从 `prompt` 现算。

判据与 `recount-cover.py` 一致（结构式轮次前缀），三处尺子错都已修：
  ① 证据行认 `user：` 不认 `用户：`
  ② 认中英文角色名，漏 `assistant：`
  ③ 漏助手用人物名写的行（`小满：`）
后两处都会让证据串带着「第N轮 + 日期」进窗口比较，前缀日期撞上提示词日期 → 假命中。
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get("BENCH22_DATA") or os.path.join(HERE, "..", "..", "cmb-2.2", "benchmark-2.2", "dataset")
if not os.path.isdir(DATA):
    DATA = os.path.join(os.path.expanduser("~"), "Desktop", "cmb-2.2", "benchmark-2.2", "dataset")

WINDOW = 8
PREFIX = re.compile(r"^第\d+轮\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+[^\s:：]+[:：]\s*(.+)$")
EVIDENCE_LINE = re.compile(r"(?:user|assistant|用户|助手)\s*[:：]\s*(.+)$")


def squash(text):
    return re.sub(r"\s+", "", str(text or ""))


def windows(text, size=WINDOW):
    body = squash(text)
    return [body[i:i + size] for i in range(len(body) - size + 1)]


def evidence_texts(evidence):
    out = []
    for line in (evidence or "").splitlines():
        line = line.strip().lstrip("-").strip()
        if not line:
            continue
        m = PREFIX.match(line) or EVIDENCE_LINE.search(line)
        if m:
            out.append(m.group(1).strip())
            continue
        out.append(re.sub(r"^F\d+[:：]\s*", "", line))
    return [x for x in out if len(squash(x)) >= 4]


def load(path):
    with open(path, encoding="utf-8") as fh:
        return [json.loads(line) for line in fh if line.strip()]


def cover(rows, key):
    """每题：命中窗口数 / 窗口总数 / 是否沾到。"""
    out = {}
    for row in rows:
        body = squash(row["prompt"])
        hit = total = 0
        for ev in evidence_texts(key[row["id"]].get("evidence")):
            wins = windows(ev)
            total += len(wins)
            hit += sum(1 for w in wins if w in body)
        out[row["id"]] = (hit, total)
    return out


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    key = {x["id"]: x for x in load(os.path.join(DATA, "natural", "natural-key-dev.jsonl"))}
    a = cover(load(sys.argv[1]), key)
    b = cover(load(sys.argv[2]), key)
    common = [i for i in a if i in b]
    better = [i for i in common if a[i][0] == 0 and b[i][0] > 0]
    worse = [i for i in common if a[i][0] > 0 and b[i][0] == 0]
    label = lambda i: f"{i:20} {key[i]['class']}/{key[i]['subtype']:3} tier{key[i]['tier']}"
    print(f"共同题 {len(common)} · 沾到 {sum(1 for i in common if a[i][0])} → {sum(1 for i in common if b[i][0])}")
    print(f"\n变好 {len(better)}：")
    for i in sorted(better):
        print("  +", label(i), f"({a[i][0]}/{a[i][1]} → {b[i][0]}/{b[i][1]})")
    print(f"\n变坏 {len(worse)}：")
    for i in sorted(worse):
        print("  -", label(i), f"({a[i][0]}/{a[i][1]} → {b[i][0]}/{b[i][1]})")
    # 仍为零的题按 class 分组，看还剩哪几格
    left = {}
    for i in common:
        if not b[i][0]:
            left.setdefault(key[i]["subtype"], []).append(i)
    print(f"\n新臂仍为零 {len([i for i in common if not b[i][0]])} 题，按 subtype：")
    for k in sorted(left):
        print(f"  {k:3} {len(left[k]):2}  {' '.join(sorted(left[k])[:6])}")
    tot_a = sum(v[0] for v in a.values())
    tot_b = sum(v[0] for v in b.values())
    win = sum(v[1] for v in b.values())
    print(f"\n逐条窗口 {tot_a}/{win} = {tot_a / win * 100:.1f}% → {tot_b}/{win} = {tot_b / win * 100:.1f}%")
    return 0


if __name__ == "__main__":
    sys.exit(main())
