import json, os, pathlib, re, subprocess, sys, tempfile
packet = pathlib.Path(__file__).parent
evidence = pathlib.Path(os.environ["PROOF_EVIDENCE"])
records_path = evidence / "runs.json"
records = json.loads(records_path.read_text()) if records_path.exists() else []
number = len(records)
labels = ["baseline", "mutation", "closing"]
if number >= len(labels):
    raise SystemExit("unexpected extra RPC invocation")
label = labels[number]
expected_tree = os.environ["EXPECTED_MUTATION_TREE"] if label == "mutation" else os.environ["EXPECTED_SOURCE_TREE"]
with tempfile.TemporaryDirectory() as d:
    env = dict(os.environ, GIT_INDEX_FILE=str(pathlib.Path(d) / "index"))
    subprocess.run(["git", "read-tree", "HEAD"], env=env, check=True)
    subprocess.run(["git", "add", "-u"], env=env, check=True)
    tree = subprocess.check_output(["git", "write-tree"], env=env, text=True).strip()
if tree != expected_tree:
    raise SystemExit(f"{label}: source tree {tree} differs from {expected_tree}")
# Cargo must see both the temporary and restored source after timestamp-preserving restoration.
os.utime("crates/web-client/src/models/fetched_account.rs", None)
log_path = evidence / f"{label}-rpc.log"
with log_path.open("w") as log:
    result = subprocess.run(["make", "test-web-client-rpc", "RUST_TEST_PROFILE=release"], stdout=log, stderr=subprocess.STDOUT)
log = log_path.read_text(errors="replace")
summaries = re.findall(r"test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out", log)
expected_counts = ("FAILED", "6", "1") if label == "mutation" else ("ok", "7", "0")
assertion = "mismatched reconstruction must not return an account"
valid = len(summaries) == 1 and summaries[0][:3] == expected_counts
valid = valid and (result.returncode != 0 if label == "mutation" else result.returncode == 0)
valid = valid and (assertion in log if label == "mutation" else True)
records.append(dict(label=label, source_tree=tree, command=["make", "test-web-client-rpc", "RUST_TEST_PROFILE=release"], exit_code=result.returncode, summaries=summaries, intended_assertion=assertion in log, valid=valid))
records_path.write_text(json.dumps(records, indent=2) + "\n")
print(log, end="")
if not valid:
    print(f"INVALID PROOF: {label}", file=sys.stderr)
    raise SystemExit(91)
raise SystemExit(result.returncode)
