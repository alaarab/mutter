#!/usr/bin/env python3
"""Build, sign, install and launch Mutter using this Mac's saved deployment setup."""

import argparse
import json
from pathlib import Path
import shlex
import subprocess
import sys

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

    previous_keychains = None
    log_path = derived_data / "deploy-build.log"
    try:
        if config.get("keychain"):
            keychain = str(Path(config["keychain"]).expanduser().resolve())
            password_path = Path(config["keychain_password_file"]).expanduser()
            if password_path.stat().st_mode & 0o077:
                raise ValueError(f"Restrict the signing password file to its owner: chmod 600 {password_path}")
            password = password_path.read_text().strip()
            if not password:
                raise ValueError("The signing keychain password file is empty.")
            # Never print the unlock command or put its password in exception output.
            unlocked = subprocess.run(
                ["security", "unlock-keychain", "-p", password, keychain],
                capture_output=True,
            )
            if unlocked.returncode:
                raise RuntimeError("Cannot unlock the configured signing keychain; check its password file.")

            previous_keychains = shlex.split(run(
                "security", "list-keychains", "-d", "user", capture_output=True, text=True,
            ).stdout)
            # codesign can otherwise select a duplicate private key in the locked login keychain.
            run("security", "list-keychains", "-d", "user", "-s", keychain,
                *[item for item in previous_keychains if item != keychain])
            command.append(f"OTHER_CODE_SIGN_FLAGS=--keychain {shlex.quote(keychain)}")

        derived_data.mkdir(parents=True, exist_ok=True)
        print(f"Building and signing Mutter. Build log: {log_path}", flush=True)
        with log_path.open("w") as log:
            result = subprocess.run(command, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
        if result.returncode:
            raise RuntimeError(f"Xcode build failed. See {log_path}")
    finally:
        if previous_keychains is not None:
            run("security", "list-keychains", "-d", "user", "-s", *previous_keychains)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
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
