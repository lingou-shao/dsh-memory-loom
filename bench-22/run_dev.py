# -*- coding: utf-8 -*-
"""把 `loom` 注册进官方 REGISTRY，然后照原样调官方 main。

`runner.py` 的 `--system` 是 `choices=sorted(REGISTRY)`，参赛系统必须在
REGISTRY 里。我们不改官方文件（他们会从干净检出跑），而是在导入之后往
**同一个 dict 对象**里塞一项——`from .systems import REGISTRY` 拿到的是引用，
`choices` 在 `parse_args()` 时才求值，所以这一步在 main 之前做就生效。

    export BENCH22_HARNESS=/path/to/chat-memory-benchmark/benchmark-2.2/harness
    python bench-22/run_dev.py --release ../dataset --system loom --split dev --run mine --sentinel
    python bench-22/run_dev.py ... --limit 5          # 先跑 5 题看看

自然用记忆榜是另一个入口（`bench22.natural`），同样要先注册：

    python bench-22/run_dev.py natural run --release ../dataset --natural ../dataset/natural ...
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
_cands = [
	os.environ.get("BENCH22_HARNESS") or "",
	os.path.join(HERE, "..", "..", "cmb-2.2", "benchmark-2.2", "harness"),
	os.path.join(os.path.expanduser("~"), "Desktop", "cmb-2.2", "benchmark-2.2", "harness"),
]
HARNESS = next((c for c in _cands if c and os.path.isdir(c)), _cands[1])
if not os.path.isdir(HARNESS):
	sys.stderr.write(f"找不到 harness：{os.path.abspath(HARNESS)}\n设 BENCH22_HARNESS 指向 benchmark-2.2/harness\n")
	sys.exit(2)

sys.path.insert(0, os.path.abspath(HARNESS))
sys.path.insert(0, HERE)

from bench22 import systems  # noqa: E402
from loom_system import register  # noqa: E402

register(systems.REGISTRY)

if len(sys.argv) > 1 and sys.argv[1] == "natural":
	sys.argv = [sys.argv[0], *sys.argv[2:]]
	from bench22 import natural  # noqa: E402

	sys.exit(natural.main())
else:
	from bench22 import runner  # noqa: E402

	sys.exit(runner.main())
