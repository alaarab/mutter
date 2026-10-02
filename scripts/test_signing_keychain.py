import ctypes
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from signing_keychain import signing_keychain, unlock_keychain


class SigningKeychainTests(unittest.TestCase):
    def setUp(self):
        self.security = Mock()
        self.core_foundation = Mock()
        self.security.SecKeychainOpen.side_effect = self.open_keychain
        self.security.SecKeychainUnlock.return_value = 0
        self.loader = patch("signing_keychain.ctypes.CDLL", side_effect=[self.security, self.core_foundation])
        self.loader.start()
        self.addCleanup(self.loader.stop)

    def open_keychain(self, path, reference):
        reference._obj.value = 123
        return 0

    def test_password_is_passed_in_memory_with_utf8_byte_length(self):
        password = "secret-雪"
        with patch("signing_keychain.subprocess.run") as run:
            unlock_keychain("/tmp/build.keychain", password)
        run.assert_not_called()
        reference, length, buffer, use_password = self.security.SecKeychainUnlock.call_args.args
        self.assertEqual(reference.value, 123)
        self.assertEqual(length, len(password.encode("utf-8")))
        self.assertEqual(buffer, password.encode("utf-8"))
        self.assertTrue(use_password)
        self.core_foundation.CFRelease.assert_called_once_with(reference)

    def test_open_failure_does_not_try_to_unlock(self):
        self.security.SecKeychainOpen.side_effect = None
        self.security.SecKeychainOpen.return_value = -25300
        with self.assertRaisesRegex(RuntimeError, "Cannot open"):
            unlock_keychain("/tmp/missing.keychain", "secret")
        self.security.SecKeychainUnlock.assert_not_called()
        self.core_foundation.CFRelease.assert_not_called()

    def test_unlock_failure_releases_reference_without_exposing_password(self):
        self.security.SecKeychainUnlock.return_value = -25293
        with self.assertRaises(RuntimeError) as result:
            unlock_keychain("/tmp/build.keychain", "private-password")
        self.assertNotIn("private-password", str(result.exception))
        self.core_foundation.CFRelease.assert_called_once()

    def test_search_order_is_restored_after_a_failed_build(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            password_file = root / "password"
            password_file.write_text("private-password")
            password_file.chmod(0o600)
            keychain = str(root / "build.keychain")
            config = {"keychain": keychain, "keychain_password_file": str(password_file)}
            with patch("signing_keychain.unlock_keychain") as unlock, patch(
                "signing_keychain.list_user_keychains", return_value=["login.keychain", keychain]
            ), patch("signing_keychain.set_user_keychains") as set_keychains:
                with self.assertRaisesRegex(RuntimeError, "Build failed"):
                    with signing_keychain(config, root):
                        raise RuntimeError("Build failed")
                unlock.assert_called_once_with(keychain, "private-password")
                self.assertEqual(set_keychains.call_args_list[-1].args, (root, ["login.keychain", keychain]))

    def test_insecure_password_permissions_fail_before_unlock(self):
        with tempfile.TemporaryDirectory() as directory:
            password_file = Path(directory) / "password"
            password_file.write_text("private-password")
            password_file.chmod(0o644)
            config = {"keychain": "/tmp/build.keychain", "keychain_password_file": str(password_file)}
            with patch("signing_keychain.unlock_keychain") as unlock:
                with self.assertRaisesRegex(ValueError, "Restrict"):
                    with signing_keychain(config, Path(directory)):
                        self.fail("An insecure password file was accepted")
                unlock.assert_not_called()


@unittest.skipUnless(sys.platform == "darwin", "Requires macOS Security.framework and the coordinated Mac lane")
class NativeSigningKeychainTests(unittest.TestCase):
    def test_unlocks_a_temporary_keychain_and_rejects_a_wrong_password(self):
        security = ctypes.CDLL("/System/Library/Frameworks/Security.framework/Security")
        core_foundation = ctypes.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
        security.SecKeychainCreate.argtypes = [
            ctypes.c_char_p, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_ubyte,
            ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p),
        ]
        security.SecKeychainCreate.restype = ctypes.c_int32
        for name in ["SecKeychainLock", "SecKeychainDelete"]:
            function = getattr(security, name)
            function.argtypes = [ctypes.c_void_p]
            function.restype = ctypes.c_int32
        core_foundation.CFRelease.argtypes = [ctypes.c_void_p]
        core_foundation.CFRelease.restype = None

        with tempfile.TemporaryDirectory() as directory:
            keychain = str(Path(directory) / "probe.keychain")
            password = "test-only-雪"
            password_bytes = password.encode("utf-8")
            reference = ctypes.c_void_p()
            self.assertEqual(security.SecKeychainCreate(
                keychain.encode(), len(password_bytes), password_bytes, False, None, ctypes.byref(reference)
            ), 0)
            try:
                self.assertEqual(security.SecKeychainLock(reference), 0)
                with self.assertRaisesRegex(RuntimeError, "Cannot unlock"):
                    unlock_keychain(keychain, "wrong-test-password")
                unlock_keychain(keychain, password)
            finally:
                security.SecKeychainDelete(reference)
                core_foundation.CFRelease(reference)


if __name__ == "__main__":
    unittest.main()
