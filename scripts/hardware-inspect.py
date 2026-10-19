"""Fixed-board lab inspection. No flash, reset, halt, or option-byte writes.

Debug attachment still configures CoreSight debug access; it is not electrically
passive. Not exposed to the renderer/model or accepted as product T2 evidence.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import time
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
PROBE = "594ac1d7613fed24"
LAYOUT_SHA = "805d84b34b040acabf2e45dd872b6516a8e637497e2d791fb4a2973b9730d8b8"


def read_diagnostics(target, flash):
    layout_path = ROOT / "output/hardware/2026-10-15/diagnostic-layout.json"
    raw_layout = layout_path.read_bytes()
    if hashlib.sha256(raw_layout).hexdigest() != LAYOUT_SHA:
        raise ValueError("Diagnostic layout differs from reviewed AXF extraction")
    layout = json.loads(raw_layout)
    from intelhex import IntelHex
    for kind in ("axf", "hex"):
        source = Path(layout["source"][kind]).resolve()
        if not source.is_relative_to(ROOT / "output/hardware"):
            raise ValueError("Diagnostic source is outside project hardware outputs")
        if hashlib.sha256(source.read_bytes()).hexdigest() != layout["source"][kind + "_sha256"]:
            raise ValueError("Diagnostic source hash mismatch")
    firmware = IntelHex(layout["source"]["hex"])
    addresses = firmware.addresses()
    if not addresses or min(addresses) < 0x08000000 or max(addresses) >= 0x08100000:
        raise ValueError("Diagnostic firmware is not internal Flash")
    if any(flash[a - 0x08000000] != firmware[a] for a in addresses):
        raise ValueError("Running Flash does not match diagnostic AXF/HEX")
    samples = []
    start = time.monotonic()
    for index in range(6):
        if index:
            time.sleep(1)
        sample = {"elapsedSeconds": time.monotonic() - start, "state": str(target.get_state()), "values": {}}
        for name, symbol in layout["symbols"].items():
            address, size = symbol["address"], symbol["size"]
            if not (0x20000000 <= address < address + size <= 0x20030000) or size > 256:
                raise ValueError("Diagnostic RAM range is invalid")
            data = bytes(target.read_memory_block8(address, size))
            sample["values"][name] = {
                field["name"]: int.from_bytes(data[field["offset"]:field["offset"] + 4], "little")
                for field in symbol["fields"]
            }
        samples.append(sample)
    checks = []
    for assertion in layout["health_assertions"]:
        values = [s["values"][assertion["symbol"]][assertion["field"]] for s in samples]
        checks.append({"name": assertion["symbol"] + "." + assertion["field"],
                       "passed": all(v == assertion["expected"] for v in values), "values": values,
                       "expected": assertion["expected"], "limitation": assertion["limitation"]})
    first = samples[0]["values"]["g_gs_board_diag"]
    last = samples[-1]["values"]["g_gs_board_diag"]
    delta = (last["camera_frames"] - first["camera_frames"]) & 0xFFFFFFFF
    checks.append({"name": "camera_frames advances", "passed": 0 < delta < 0x80000000, "delta": delta})
    for field in ("camera_errors", "camera_timeouts", "display_errors"):
        checks.append({"name": field + " unchanged", "passed": first[field] == last[field],
                       "before": first[field], "after": last[field]})
    checks.append({"name": "CPU stays running", "passed": all(s["state"] == "State.RUNNING" for s in samples)})
    checks.append({"name": "USB capture observed disabled after lab sample",
                   "passed": all(s["values"]["g_gs_usb_diag"]["capture_enabled"] == 0 for s in samples)})
    return {"result": "passed" if all(c["passed"] for c in checks) else "failed", "layoutSha256": LAYOUT_SHA,
            "verifiedFlashBytes": len(addresses), "samples": samples, "checks": checks,
            "limitations": layout["observation_rules"]}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--diagnostics", action="store_true")
    args = parser.parse_args()
    output = Path(args.output).resolve()
    if not output.is_relative_to(ROOT / "output" / "hardware"):
        raise ValueError("Evidence must stay inside project output/hardware")
    output.mkdir(parents=True, exist_ok=False)
    evidence = {"scope": "external-lab-inspection-not-product-T2", "result": "failed",
                "startedAt": datetime.now(timezone.utc).isoformat(), "probeSerial": PROBE,
                "reset": False, "halt": False, "flashWritten": False,
                "debugAccessConfigured": True}
    try:
        from pyocd.core.helpers import ConnectHelper
        from pyocd.core.session import Session

        class IsolatedSession(Session):
            def _load_user_script(self):
                pass  # Never discover or execute a repository pyocd_user.py.

        probes = ConnectHelper.get_all_connected_probes(blocking=False)
        matches = [p for p in probes if p.unique_id.lower() == PROBE]
        if len(probes) != 1 or len(matches) != 1:
            raise ValueError("Exactly the selected fireDAP probe must be present")
        evidence["probeDescription"] = matches[0].description
        session = IsolatedSession(matches[0], options={
            "target_override": "cortex_m", "connect_mode": "attach",
            "frequency": 1000000, "auto_unlock": False, "no_config": True,
            "resume_on_disconnect": False, "cache.enable_memory": False,
            "cache.enable_register": False, "cache.read_code_from_elf": False,
            "project_dir": str(output),
        })
        with session:
            target = session.target
            evidence["stateBefore"] = str(target.get_state())
            chip = target.read32(0xE0042000)
            size = target.read16(0x1FFF7A22)
            uid = [target.read32(0x1FFF7A10 + i * 4) for i in range(3)]
            evidence.update(chipId=chip & 0xFFF, debugMcuId=hex(chip), flashKiB=size,
                            uidWords=uid, uid="".join(f"{x:08x}" for x in uid))
            if chip & 0xFFF != 0x419 or size != 1024 or uid in ([0]*3, [0xFFFFFFFF]*3):
                raise ValueError("Observed chip/flash/UID does not match STM32F429xG")
            first = bytearray()
            for address in range(0x08000000, 0x08100000, 4096):
                first.extend(target.read_memory_block8(address, 4096))
            # A second full read establishes stability without halting the MCU.
            second = hashlib.sha256()
            for address in range(0x08000000, 0x08100000, 4096):
                second.update(bytes(target.read_memory_block8(address, 4096)))
            digest = hashlib.sha256(first).hexdigest()
            if digest != second.hexdigest():
                raise ValueError("Flash changed between backup reads")
            backup = output / "internal-flash-before.bin"
            backup.write_bytes(first)
            evidence.update(backup=str(backup), backupBytes=len(first), backupSha256=digest,
                            stableDoubleRead=True, stateAfter=str(target.get_state()))
            if args.diagnostics:
                evidence["diagnostics"] = read_diagnostics(target, first)
        evidence["sessionClosed"] = True
        evidence["result"] = evidence.get("diagnostics", {}).get("result", "passed")
    except Exception as error:
        evidence["error"] = f"{type(error).__name__}: {error}"
    finally:
        (output / "evidence.json").write_text(json.dumps(evidence, indent=2), encoding="utf-8")
        print(json.dumps(evidence, indent=2))
    return 0 if evidence["result"] == "passed" else 1


if __name__ == "__main__":
    sys.exit(main())
