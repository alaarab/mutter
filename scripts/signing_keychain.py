import shlex
import subprocess
from contextlib import contextmanager
from pathlib import Path


def list_user_keychains(root):
    listed = subprocess.run(
        ["security", "list-keychains", "-d", "user"],
        cwd=root, capture_output=True, text=True, check=True,
    ).stdout
    return shlex.split(listed)


def set_user_keychains(root, keychains):
    subprocess.run(["security", "list-keychains", "-d", "user", "-s", *keychains], cwd=root, check=True)


@contextmanager
def signing_keychain(config, root):
    if not config.get("keychain"):
        yield []
        return

    keychain = str(Path(config["keychain"]).expanduser().resolve())
    password_path = Path(config["keychain_password_file"]).expanduser()
    if password_path.stat().st_mode & 0o077:
        raise ValueError(f"Restrict the signing password file to its owner: chmod 600 {password_path}")
    password = password_path.read_text().strip()
    if not password:
        raise ValueError("The signing keychain password file is empty.")

    unlocked = subprocess.run(
        ["security", "unlock-keychain", "-p", password, keychain],
        capture_output=True,
        check=False,
    )
    if unlocked.returncode:
        raise RuntimeError("Cannot unlock the configured signing keychain; check its password file.")

    previous_keychains = list_user_keychains(root)
    set_user_keychains(root, [keychain, *[item for item in previous_keychains if item != keychain]])
    try:
        yield [f"OTHER_CODE_SIGN_FLAGS=--keychain {shlex.quote(keychain)}"]
    finally:
        set_user_keychains(root, previous_keychains)
