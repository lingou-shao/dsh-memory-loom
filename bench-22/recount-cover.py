"""用修好的证据解析，重算**已落盘**的产物——不重放、不重跑。

为什么要这一步：dev key 的证据行有两种写法，59 题写 `user：`，27 题写
`用户：`（其中 17 题整题都是后者）。判据原来只认前者，于是那 17 题的证据串里
带着「第4193轮 2027-01-29 22:22 用户：」这一截前缀，8 字窗永远落不进提示词
——**不管产品做什么，它们都算没命中**。

这不是产品读数，是尺子的错（和 §94/§98 同一类）。提示词已经逐题存在产物里，
所以修法是把判据修好、在**同一批提示词**上重算一遍，两次读数的差别就只是尺子。

    python bench-22/recount-cover.py work/natural-22-v6.jsonl work/natural-22-v7.jsonl ...
"""
import json
import os
import re
import statistics
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(
    os.environ.get("BENCH22_DATA", ""),
    "benchmark-2.2",
    "dataset",
) if os.environ.get("BENCH22_DATA") else None
if DATA is None or not os.path.isdir(DATA):
    for one in (
        os.path.join(HERE, "..", "..", "cmb-2.2", "benchmark-2.2", "dataset"),
        os.path.expanduser("~/Desktop/cmb-2.2/benchmark-2.2/dataset"),
    ):
        if os.path.isdir(os.path.join(one, "natural")):
            DATA = one
            break

WINDOW = 8
# 证据行的轮次前缀有四种角色名（user 152 / 用户 68 / assistant 28 / 小满 21），
# 按名字枚举必然漏。按**结构**认：第N轮 + 日期 + 时刻 + 任意角色名 + 冒号。
# 漏掉的行会把前缀里的日期一起带进窗口比较，撞上提示词里的日期 → 假命中。
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


def score(rows, key):
    hit_total = 0
    win_total = 0
    any_hit = 0
    full = 0
    for row in rows:
        body = squash(row["prompt"])
        evs = evidence_texts(key[row["id"]].get("evidence"))
        hit = 0
        total = 0
        for ev in evs:
            wins = windows(ev)
            total += len(wins)
            hit += sum(1 for w in wins if w in body)
        win_total += total
        hit_total += hit
        any_hit += 1 if hit else 0
        full += 1 if total and hit == total else 0
    return {
        "n": len(rows),
        "any": any_hit,
        "full": full,
        "hit": hit_total,
        "total": win_total,
        "tokens": statistics.median([r["tokens"] for r in rows]),
    }


def main():
    key = {x["id"]: x for x in load(os.path.join(DATA, "natural", "natural-key-dev.jsonl"))}
    arms = sys.argv[1:] or [os.path.join(HERE, "work", "natural-22-v7.jsonl")]
    print(f"{'产物':28} {'题':>3} {'沾到(旧→新)':>18} {'逐条(旧→新)':>20} {'全中(旧→新)':>14}")
    for path in arms:
        real = path if os.path.isabs(path) else (path if os.path.exists(path) else os.path.join(HERE, path))
        rows = load(real)
        # 旧口径：只认 `user：`。注意 `PREFIX` 也要一起废掉，否则结构式前缀会先命中，
        # 「旧」列就变成了「新」列的副本（第一版就是这么错的）。
        old = (EVIDENCE_LINE, PREFIX)
        try:
            globals()["EVIDENCE_LINE"] = re.compile(r"user[:：]\s*(.+)$")
            globals()["PREFIX"] = re.compile(r"(?!x)x")
            was = score(rows, key)
        finally:
            globals()["EVIDENCE_LINE"], globals()["PREFIX"] = old
        now = score(rows, key)
        name = os.path.basename(path)
        print(
            f"{name:28} {now['n']:3} "
            f"{was['any']:>3}→{now['any']:>3} ({now['any'] / now['n'] * 100:4.1f}%) "
            f"{was['hit']:>4}/{was['total']}→{now['hit']}/{now['total']} ({now['hit'] / now['total'] * 100:4.1f}%) "
            f"{was['full']:>2}→{now['full']:>2}",
        )


if __name__ == "__main__":
    main()
