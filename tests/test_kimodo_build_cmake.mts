/**
 * Unit tests for kimodo/build_cmake.py (run: npx --yes tsx tests/test_kimodo_build_cmake.mts)
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const py = process.env.PYTHON ?? "python3";

const snippet = `
import sys
sys.path.insert(0, ${JSON.stringify(path.join(repoRoot, "kimodo"))})
from build_cmake import python_cmake_args, python_dev_headers_ready, kimodo_build_packages
args = python_cmake_args()
assert any(a.startswith("-DPython3_INCLUDE_DIR=") and len(a) > len("-DPython3_INCLUDE_DIR=") for a in args)
assert f"-DPython3_EXECUTABLE={sys.executable}" in args
assert "-DPython3_FIND_UNVERSIONED_NAMES=OFF" in args
assert isinstance(python_dev_headers_ready(), bool)
py_tag = f"{sys.version_info.major}.{sys.version_info.minor}"
assert kimodo_build_packages() == ["cmake", "build-essential", f"python{py_tag}-dev"]
print("test_kimodo_build_cmake: ok")
`;

const proc = spawnSync(py, ["-c", snippet], { encoding: "utf-8" });
if (proc.status !== 0) {
  console.error(proc.stderr || proc.stdout);
  process.exit(proc.status ?? 1);
}
console.log(proc.stdout.trim());
