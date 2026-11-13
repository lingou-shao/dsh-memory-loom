"""X4 子类逐题体检：块里有没有那一行、是哪一行、为什么没中。零重放。"""
import json, os, re, sys

KEY = os.path.expanduser("~/Desktop/cmb-2.2/benchmark-2.2/dataset/natural/natural-key-dev.jsonl")
PROD = sys.argv[1] if len(sys.argv) > 1 else "work/natural-22-v12.jsonl"
SUB = sys.argv[2] if len(sys.argv) > 2 else "X4"

PREFIX = re.compile(r"^第\d+轮\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+[^\s:：]+[:：]\s*(.+)$")
EVIDENCE_LINE = re.compile(r"(?:user|assistant|用户|助手)\s*[:：]\s*(.+)$")


def squash(t):
    return re.sub(r"\s+", "", str(t or ""))


def evid(ev):
    out = []
    for line in (ev or "").splitlines():
        line = line.strip().lstrip("-").strip()
        if not line:
            continue
        m = PREFIX.match(line) or EVIDENCE_LINE.search(line)
        out.append(m.group(1).strip() if m else re.sub(r"^F\d+[:：]\s*", "", line))
    return [x for x in out if len(squash(x)) >= 4]


def hits(ev, body):
    s = squash(ev)
    return sum(1 for i in range(len(s) - 7) if s[i:i + 8] in body)


key = {}
for l in open(KEY, encoding="utf-8"):
    if l.strip():
        r = json.loads(l)
        key[r["id"]] = r

prod = {}
for l in open(PROD, encoding="utf-8"):
    if l.strip():
        r = json.loads(l)
        prod[r["id"]] = r

ids = [i for i, r in key.items() if r.get("subtype") == SUB]
print(f"{SUB} 共 {len(ids)} 题，产物 {os.path.basename(PROD)}\n")
ok = 0
for i in sorted(ids):
    if i not in prod:
        print(f"?? {i} 产物里没有")
        continue
    body = squash(prod[i]["prompt"])
    evs = evid(key[i].get("evidence"))
    got = [e for e in evs if hits(e, body)]
    mark = "O" if got else "."
    ok += 1 if got else 0
    # 块里的到期行
    due = [ln.strip() for ln in prod[i]["prompt"].splitlines() if ln.strip().startswith("- [今天]")]
    print(f"[{mark}] {i}  {key[i].get('prompt','')[:34]}")
    if not got:
        for e in evs[:2]:
            print(f"      证据 :: {e[:88]}")
        if due:
            for d in due[:3]:
                print(f"      块里 :: {d[:88]}")
        else:
            print("      块里 :: （没有今天该做的事这一区）")
print(f"\n命中 {ok}/{len(ids)}")
