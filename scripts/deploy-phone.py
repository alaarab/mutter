#!/usr/bin/env python3

import argparse
import json
import subprocess
import sys
from pathlib import Path

from signing_keychain import signing_keychain

ROOT = Path(__file__).resolve().parents[1]


def run(*command, **options):
    return subprocess.run(command, check=True, cwd=ROOT, **options)


def build(config, derived_data):
    command = [
        "xcodebuild", "-project", "Mutter.xcodeproj", "-scheme", "Mutter",
        "-configuration", "Debug", "-destination", "generic/platform=iOS",
        "-derivedDataPath", str(derived_data), "-allowProvisioningUpdates", "build",
    ]
    if config.get("source_packages"):
        command.extend([
            "-clonedSourcePackagesDirPath", str(Path(config["source_packages"]).expanduser()),
            "-disableAutomaticPackageResolution",
        ])

    log_path = derived_data / "deploy-build.log"
    with signing_keychain(config, ROOT) as signing_settings:
        derived_data.mkdir(parents=True, exist_ok=True)
        print(f"Building and signing Mutter. Build log: {log_path}", flush=True)
        with log_path.open("w") as log:
            result = subprocess.run(command + signing_settings, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=False)
        if result.returncode:
            raise RuntimeError(f"Xcode build failed. See {log_path}")


def main():
    parser = argparse.ArgumentParser(description="Build, sign, install and launch Mutter on an iOS device.")
    parser.add_argument("--device", help="Override the device saved in Local.deploy.json")
    args = parser.parse_args()
    config_path = ROOT / "Local.deploy.json"
    if not config_path.exists():
        raise ValueError("Copy Local.deploy.json.example to Local.deploy.json and configure this Mac first.")
    config = json.loads(config_path.read_text())
    device = args.device or config.get("device")
    if not device:
        raise ValueError("Set device in Local.deploy.json or pass --device.")
    derived_data = Path(config.get(
        "derived_data", "~/Library/Developer/Xcode/DerivedData/MutterPhone",
    )).expanduser().resolve()

    run("xcrun", "devicectl", "device", "info", "lockState", "--device", device, "--timeout", "30")
    run("xcodegen", "generate")
    build(config, derived_data)
    app = derived_data / "Build/Products/Debug-iphoneos/Mutter.app"
    run("codesign", "--verify", "--deep", "--strict", str(app))
    run("xcrun", "devicectl", "device", "install", "app", "--device", device, str(app))
    run("xcrun", "devicectl", "device", "process", "launch", "--device", device,
        "--terminate-existing", "com.alaarab.mutter")
    print("Mutter installed and launched.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
