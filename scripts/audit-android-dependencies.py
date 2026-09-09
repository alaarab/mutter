import json
import ssl
import sys
from http.client import HTTPSConnection
from pathlib import Path

root = Path(__file__).resolve().parents[1]
directory = root / "android/build/reports/security"
dependencies = json.loads((directory / "dependencies.json").read_text())
connection = HTTPSConnection("api.osv.dev", timeout=60, context=ssl.create_default_context())
connection.request(
    "POST", "/v1/querybatch",
    body=json.dumps({"queries": [
        {"package": {"ecosystem": "Maven", "name": item["name"]}, "version": item["version"]}
        for item in dependencies
    ]}).encode(),
    headers={"Content-Type": "application/json"},
)
with connection.getresponse() as response:
    if response.status != 200:
        raise RuntimeError(f"OSV request failed: HTTP {response.status}")
    results = json.load(response)["results"]
connection.close()
if len(results) != len(dependencies):
    raise RuntimeError("OSV returned an incomplete response")
findings = [
    {**dependency, "advisories": [item["id"] for item in result.get("vulns", [])]}
    for dependency, result in zip(dependencies, results)
]
(directory / "osv.json").write_text(json.dumps(findings, indent=2) + "\n")
affected = [item for item in findings if item["advisories"]]
for item in affected:
    print(f"{item['scope']}: {item['name']}:{item['version']}: {', '.join(item['advisories'])}")
print(f"Scanned {len(dependencies)} resolved dependencies; {len(affected)} affected artifacts.")
sys.exit(bool(affected))
