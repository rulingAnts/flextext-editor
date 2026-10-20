"""Driven by test/fxdiag-suite-sync.test.mjs: the suite's storage facts, harvested from docs/js and the
worker config, come in as JSON on stdin; every one that fxdiag's suite.py does not recognise comes
back as a problem. Run with -I from the repository root."""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from fxdiag import suite  # noqa: E402

facts = json.load(sys.stdin)
problems = []
for host in facts.get("hosts", []):
    if not suite.is_suite_host(host):
        problems.append("host not recognised by fxdiag/suite.py is_suite_host: %s" % host)
for name in facts.get("dbNames", []):
    if not suite.is_suite_db(name):
        problems.append("IndexedDB database name fxdiag would skip (suite.is_suite_db): %s" % name)
for key in facts.get("storageKeys", []):
    if not suite.is_suite_key(key):
        problems.append("localStorage key fxdiag would skip (suite.is_suite_key): %s" % key)
if facts.get("docsDb") and facts["docsDb"] != suite.DOCS_DB:
    problems.append("db.js DB_NAME %r != suite.DOCS_DB %r" % (facts["docsDb"], suite.DOCS_DB))
print(json.dumps({"problems": problems, "checked": {k: len(v) if isinstance(v, list) else v for k, v in facts.items()}}))
