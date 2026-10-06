import json
import sys

command = sys.argv[1]
args = json.load(sys.stdin)
if command == "pyecho-fail":
    print("bad credentials", file=sys.stderr)
    sys.exit(3)
print(json.dumps({"command": command, "args": args}))
