import ctypes
import os
import shlex
import subprocess
from contextlib import contextmanager
from pathlib import Path


def unlock_keychain(keychain, password):
    security = ctypes.CDLL("/System/Library/Frameworks/Security.framework/Security")
    core_foundation = ctypes.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
    security.SecKeychainOpen.argtypes = [ctypes.c_char_p, ctypes.POINTER(ctypes.c_void_p)]
    security.SecKeychainOpen.restype = ctypes.c_int32
    security.SecKeychainUnlock.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_ubyte]
    security.SecKeychainUnlock.restype = ctypes.c_int32
    core_foundation.CFRelease.argtypes = [ctypes.c_void_p]
    core_foundation.CFRelease.restype = None

    reference = ctypes.c_void_p()
    status = security.SecKeychainOpen(os.fsencode(keychain), ctypes.byref(reference))
    if status:
        raise RuntimeError(f"Cannot open the configured signing keychain (OSStatus {status}).")
    try:
        password_bytes = password.encode("utf-8")
        status = security.SecKeychainUnlock(reference, len(password_bytes), password_bytes, True)
        if status:
            raise RuntimeError(f"Cannot unlock the configured signing keychain (OSStatus {status}); check its password file.")
    finally:
        core_foundation.CFRelease(reference)


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

    unlock_keychain(keychain, password)

    previous_keychains = list_user_keychains(root)
    set_user_keychains(root, [keychain, *[item for item in previous_keychains if item != keychain]])
    try:
        yield [f"OTHER_CODE_SIGN_FLAGS=--keychain {shlex.quote(keychain)}"]
    finally:
        set_user_keychains(root, previous_keychains)
