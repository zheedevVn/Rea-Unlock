import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { GHIDRA_BRIDGE_SOURCES } from "../src/ghidra/GhidraBridgeSources.ts";

const exec = promisify(execFile);
const packedHopperBridge = "package/bridge/hopper_bridge.py";
const packedCutterBridge = "package/bridge/cutter/rea_bridge.py";

/** Check shipped bridge files; real-provider lanes verify runtime behavior. */
export async function verifyPackedBridge({ workspace, tarball, packedFiles }) {
  for (const path of [
    packedHopperBridge,
    packedCutterBridge,
    ...Object.values(GHIDRA_BRIDGE_SOURCES).map(
      (name) => `package/bridge/ghidra/${name}`,
    ),
  ]) {
    if (!packedFiles.includes(path)) throw new Error(`package omitted ${path}`);
  }
  await exec("tar", ["-xf", tarball, "-C", workspace]);
  // Parse the actual packed Python source without loading Hopper globals or
  // generating bytecode. This check has no dependency on test-only fixtures.
  await exec("python3", [
    "-c",
    "import ast, pathlib, sys; p = pathlib.Path(sys.argv[1]); ast.parse(p.read_text(encoding='utf-8'), filename=str(p))",
    join(workspace, packedHopperBridge),
  ]);
}
