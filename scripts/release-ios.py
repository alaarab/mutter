#!/usr/bin/env python3

import argparse
import json
import plistlib
import re
import subprocess
import sys
from pathlib import Path

from signing_keychain import signing_keychain

ROOT = Path(__file__).resolve().parents[1]
RELEASE_CREDENTIALS = Path.home() / ".config/ios-release.json"
DEFAULT_ARCHIVES = Path.home() / "Library/Developer/Xcode/Archives/mutter"


def run(*command, **options):
    return subprocess.run(command, check=True, cwd=ROOT, **options)


def marketing_version():
    match = re.search(r'^\s*MARKETING_VERSION:\s*"?([^"\n]+)"?\s*$', (ROOT / "project.yml").read_text(), re.MULTILINE)
    if not match:
        raise ValueError("project.yml has no MARKETING_VERSION.")
    return match.group(1).strip()


def development_team(requested_team):
    if requested_team:
        return requested_team
    local_settings = ROOT / "Local.xcconfig"
    if local_settings.exists():
        for line in local_settings.read_text().splitlines():
            match = re.match(r"^\s*DEVELOPMENT_TEAM\s*=\s*(\S+)\s*$", line.split("//", 1)[0])
            if match:
                return match.group(1)
    raise ValueError("Set DEVELOPMENT_TEAM in Local.xcconfig or pass --team.")


def app_store_connect_authentication():
    if not RELEASE_CREDENTIALS.exists():
        return []
    saved = json.loads(RELEASE_CREDENTIALS.read_text())
    key_path = Path(saved.get("key_path", "")).expanduser()
    if not (saved.get("key_id") and saved.get("issuer_id") and key_path.exists()):
        raise ValueError(f"{RELEASE_CREDENTIALS} needs key_id, issuer_id and an existing key_path.")
    return [
        "-authenticationKeyPath", str(key_path),
        "-authenticationKeyID", saved["key_id"],
        "-authenticationKeyIssuerID", saved["issuer_id"],
    ]


def deploy_config():
    config_path = ROOT / "Local.deploy.json"
    return json.loads(config_path.read_text()) if config_path.exists() else {}


def main():
    parser = argparse.ArgumentParser(description="Archive Mutter for iOS and export it or upload it to TestFlight.")
    parser.add_argument("--build-number", required=True, type=int, help="Higher than every build already uploaded")
    parser.add_argument("--team", help="Apple team ID; defaults to DEVELOPMENT_TEAM in Local.xcconfig")
    parser.add_argument("--output", type=Path, default=DEFAULT_ARCHIVES)
    parser.add_argument("--upload", action="store_true", help="Upload to App Store Connect for TestFlight")
    args = parser.parse_args()
    if args.build_number < 1:
        parser.error("The build number must be positive.")

    version = marketing_version()
    team = development_team(args.team)
    authentication = app_store_connect_authentication()
    output = args.output.expanduser().resolve() / f"{version}-{args.build_number}"
    archive = output / "Mutter.xcarchive"
    if archive.exists():
        raise ValueError(f"{archive} already exists; choose a new build number.")
    output.mkdir(parents=True, exist_ok=True)

    print(f"Archiving Mutter {version} build {args.build_number} for team {team}.", flush=True)
    run("xcodegen", "generate")
    build_settings = [
        f"CURRENT_PROJECT_VERSION={args.build_number}",
        f"DEVELOPMENT_TEAM={team}",
        "CODE_SIGN_STYLE=Automatic",
    ]
    export_options = output / "ExportOptions.plist"
    export_options.write_bytes(plistlib.dumps({
        "method": "app-store-connect",
        "teamID": team,
        "signingStyle": "automatic",
        "destination": "upload" if args.upload else "export",
        "manageAppVersionAndBuildNumber": False,
        "uploadSymbols": True,
    }))

    with signing_keychain(deploy_config(), ROOT) as signing_settings:
        run(
            "xcodebuild", "-project", "Mutter.xcodeproj", "-scheme", "Mutter", "-configuration", "Release",
            "archive", "-destination", "generic/platform=iOS", "-archivePath", str(archive),
            "-allowProvisioningUpdates", "-skipPackagePluginValidation",
            *build_settings, *signing_settings,
        )
        run(
            "xcodebuild", "-exportArchive", "-archivePath", str(archive),
            "-exportPath", str(output / "export"), "-exportOptionsPlist", str(export_options),
            "-allowProvisioningUpdates", *authentication,
        )

    if args.upload:
        print(f"Uploaded Mutter {version} ({args.build_number}). It appears in TestFlight once App Store Connect finishes processing.")
    else:
        print(f"Exported Mutter {version} ({args.build_number}) to {output / 'export'}")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
