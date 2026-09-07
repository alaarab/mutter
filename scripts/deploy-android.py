#!/usr/bin/env python3

import argparse
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description="Build, install and launch Mutter on an Android device.")
    parser.add_argument("--device", help="ADB device serial; required when several devices are connected")
    parser.add_argument("--build-only", action="store_true", help="Build APKs without installing")
    args = parser.parse_args()
    env = os.environ.copy()
    if not env.get("JAVA_HOME"):
        jdk = Path("/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home")
        if jdk.exists():
            env["JAVA_HOME"] = str(jdk)
    sdk = Path(env.get("ANDROID_HOME", env.get("ANDROID_SDK_ROOT", str(Path.home() / "Library/Android/sdk"))))
    env["ANDROID_HOME"] = str(sdk)

    def run(*command, **options):
        return subprocess.run(command, cwd=ROOT, env=env, check=True, **options)

    adb = str(sdk / "platform-tools/adb")
    device = args.device
    if not args.build_only:
        devices = run(adb, "devices", capture_output=True, text=True).stdout.splitlines()[1:]
        available = [line.split()[0] for line in devices if len(line.split()) >= 2 and line.split()[1] == "device"]
        if device is None:
            if len(available) != 1:
                raise ValueError("Connect and unlock an Android device with USB debugging enabled, or select one using --device.")
            device = available[0]
        if device not in available:
            raise ValueError("The selected Android device is offline or has not authorized USB debugging.")

    run("node", "scripts/generate-themes.mjs", "--check")
    run(str(ROOT / "android/gradlew"), "-p", "android", ":app:assembleDebug")
    output = ROOT / "android/app/build/outputs/apk/debug"
    if args.build_only:
        print(f"APKs ready: {output}")
        return
    abi = run(adb, "-s", device, "shell", "getprop", "ro.product.cpu.abi", capture_output=True, text=True).stdout.strip()
    apk = output / f"app-{abi}-debug.apk"
    if not apk.exists():
        apk = output / "app-universal-debug.apk"
    run(adb, "-s", device, "install", "-r", str(apk))
    run(adb, "-s", device, "shell", "am", "start", "-n", "com.alaarab.mutter/.MainActivity")
    print(f"Mutter installed and launched on {device}.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
