"""Fixed-board diagnostics; explicit recovery mode resets and halts, never flashes."""
import importlib.util
import json
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("fixed_worker", ROOT / "install/resources/hardware-worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
out = ROOT / "output/hardware/t2-integration" / ("fault-readonly-" + str(time.time_ns()))
out.mkdir()
recover = sys.argv[1:] == ["--recover-reset-halt"]
if sys.argv[1:] and not recover:
    raise ValueError("Only --recover-reset-halt is supported")
report = {"scope": "post-failure-reset-halt-no-flash" if recover else "post-failure-no-reset-no-halt-no-flash", "output": str(out)}
addresses = {"DHCSR": 0xE000EDF0, "CFSR": 0xE000ED28, "HFSR": 0xE000ED2C,
             "BFAR": 0xE000ED38, "MMFAR": 0xE000ED34, "VTOR": 0xE000ED08,
             "FLASH_SR": 0x40023C0C, "FLASH_CR": 0x40023C10,
             "MPU_CTRL": 0xE000ED94, "DEMCR": 0xE000EDFC}
try:
    with worker.session(worker.find_probe(), "cortex_m", out, False) as connection:
        target = connection.target
        if recover:
            worker.require(target.read32(0xE0042000) == 0x20036419, "fixed chip ID before recovery")
            from pyocd.core.target import Target
            target.reset_and_halt(reset_type=Target.ResetType.SYSRESETREQ)
            report["recoveryAction"] = "SYSRESETREQ reset_and_halt; no erase/program/resume"
        report["rawIdentity"] = {"dbgmcuIdcode": f"0x{target.read32(0xE0042000):08x}",
                                 "flashKiB": target.read16(0x1FFF7A22),
                                 "uid": worker.canonical_uid(bytes(target.read_memory_block8(0x1FFF7A10, 12)))}
        report["state"] = str(target.get_state())
        report["registers"] = {name: f"0x{target.read32(address):08x}" for name, address in addresses.items()}
        if report["state"].endswith("HALTED"):
            report["coreRegisters"] = {name: f"0x{target.read_core_register_raw(name):08x}" for name in
                                       ("pc", "lr", "sp", "msp", "psp", "xpsr", "control", "primask", "basepri", "faultmask")}
        report["identity"] = worker.identify(target)
        first = worker.read_flash(target)
        second = worker.read_flash(target)
        worker.atomic_bytes(out / "flash-current.bin", first)
        report["flash"] = {"sha256": worker.sha256(first), "bytes": len(first), "doubleReadMatch": first == second}
        previous = ROOT / ".runtime/t2/t2-1792063884804-e2f11c/data/embedded/da02a255-f4b8-466d-b5b3-ec6fe440fc9f/operations/35fc5c84-3ffb-462f-9b70-3ed41ba5bf3d/flash-backup.bin"
        backup = previous.read_bytes()
        report["flash"]["originalBackupSha256"] = worker.sha256(backup)
        report["flash"]["differentBytesFromOriginal"] = sum(a != b for a, b in zip(first, backup))
    report["result"] = "collected"
except Exception as error:
    report["result"] = "failed"
    report["error"] = type(error).__name__ + ": " + str(error)
worker.atomic_json(out / "evidence.json", report)
print(json.dumps(report, indent=2))
sys.exit(0 if report["result"] == "collected" else 1)
