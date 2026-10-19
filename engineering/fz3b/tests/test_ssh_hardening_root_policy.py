"""No hardware/process/filesystem writes; pure policy and command fixtures."""
import ast
from contextlib import ExitStack
import hashlib
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest import mock


PATH = Path(__file__).resolve().parents[1] / 'tools' / 'ssh_hardening_root_policy.py'
spec = importlib.util.spec_from_file_location('ssh_hardening_root_policy', PATH)
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)


def sha(value):
    return hashlib.sha256(value).hexdigest()


class RootPolicyTests(unittest.TestCase):
    def test_candidate_preserves_exact_preimage_and_appends_only_root_match(self):
        original = b'Port 22\nPasswordAuthentication yes\n'
        old_size, old_sha = policy.CONFIG_SIZE, policy.CONFIG_SHA
        try:
            policy.CONFIG_SIZE, policy.CONFIG_SHA = len(original), sha(original)
            candidate = policy.planned_bytes(original)
            self.assertEqual(candidate[:len(original)], original)
            self.assertEqual(candidate[len(original):], policy.SUFFIX)
            self.assertEqual(candidate.lower().count(b'match user root'), 1)
            unexpected = b'Match All\n'.ljust(len(original), b' ')
            policy.CONFIG_SHA = sha(unexpected)
            with self.assertRaisesRegex(ValueError, 'unexpected-config-structure'):
                policy.planned_bytes(unexpected)
        finally:
            policy.CONFIG_SIZE, policy.CONFIG_SHA = old_size, old_sha

    def test_effective_precommit_covers_two_root_and_two_nonroot_contexts(self):
        base = (b'pubkeyauthentication yes\npasswordauthentication yes\n'
                b'kbdinteractiveauthentication no\npermitrootlogin yes\n'
                b'authenticationmethods any\nmaxsessions 10\n'
                b'hostkey /etc/ssh/a\nhostkey /etc/ssh/b\n')
        candidate = (b'pubkeyauthentication yes\npasswordauthentication no\n'
                     b'kbdinteractiveauthentication no\npermitrootlogin without-password\n'
                     b'authenticationmethods publickey\nmaxsessions 10\n'
                     b'hostkey /etc/ssh/a\nhostkey /etc/ssh/b\n')
        seen = []
        def runner(argv, seconds, limit):
            seen.append(argv)
            if '-t' in argv:
                return 0, b'', sha(b'')
            self.assertIn('-C', argv)
            root = 'user=root,' in argv[-1]
            staged = argv[argv.index('-f') + 1].endswith(policy.STAGE)
            return 0, candidate if root and staged else base, sha(b'')
        hashes = policy._verify_candidate(runner, '/etc/ssh/sshd_config',
                                          '/etc/ssh/' + policy.STAGE)
        self.assertEqual(hashes['before'], [sha(base)] * 4)
        self.assertEqual(hashes['after'], [sha(candidate), sha(candidate), sha(base), sha(base)])
        self.assertEqual(sum('-T' in entry for entry in seen), 8)
        self.assertEqual(sum('-t' in entry for entry in seen), 2)

    def test_nonroot_change_or_root_password_remaining_fails_before_commit(self):
        base = (b'pubkeyauthentication yes\npasswordauthentication yes\n'
                b'kbdinteractiveauthentication no\npermitrootlogin yes\n'
                b'authenticationmethods any\n')
        root = (b'pubkeyauthentication yes\npasswordauthentication no\n'
                b'kbdinteractiveauthentication no\npermitrootlogin without-password\n'
                b'authenticationmethods publickey\n')
        def runner(argv, seconds, limit):
            if '-t' in argv:
                return 0, b'', sha(b'')
            staged = argv[argv.index('-f') + 1].endswith(policy.STAGE)
            if staged and 'user=root,' in argv[-1]:
                return 0, root, sha(b'')
            if staged:
                return 0, base + b'banner /changed\n', sha(b'')
            return 0, base, sha(b'')
        with self.assertRaisesRegex(ValueError, 'nonroot-effective-change'):
            policy._verify_candidate(runner, '/etc/ssh/sshd_config',
                                     '/etc/ssh/' + policy.STAGE)
        def unsafe_root(argv, seconds, limit):
            if '-t' in argv:
                return 0, b'', sha(b'')
            return 0, base, sha(b'')
        with self.assertRaisesRegex(ValueError, 'root-effective-policy-mismatch'):
            policy._verify_candidate(unsafe_root, '/etc/ssh/sshd_config',
                                     '/etc/ssh/' + policy.STAGE)

    def test_service_pins_reload_not_restart_and_fails_other_unit(self):
        data = (b'Id=ssh.service\nFragmentPath=/lib/systemd/system/ssh.service\n'
                b'MainPID=3431\nActiveState=active\nLoadState=loaded\n'
                b'ExecReload={ path=/usr/sbin/sshd ; argv[]=/usr/sbin/sshd -t ; ignore_errors=no ; status=0 }\n'
                b'ExecReload={ path=/bin/kill ; argv[]=/bin/kill -HUP $MAINPID ; ignore_errors=no ; status=0 }\n')
        def runner(argv, seconds, limit):
            self.assertEqual(argv[0:3], (policy.SYSTEMCTL, 'show', 'ssh.service'))
            return 0, data, sha(b'')
        self.assertEqual(policy._service(runner), 3431)
        with self.assertRaisesRegex(ValueError, 'service-identity-mismatch'):
            policy._service(lambda argv, seconds, limit:
                            (0, data.replace(b'Id=ssh.service', b'Id=other.service'), sha(b'')))

    def test_python36_and_no_install_or_password_mutation(self):
        source = PATH.read_text(encoding='utf-8')
        ast.parse(source, feature_version=(3, 6))
        self.assertNotIn('/etc/shadow', source)
        self.assertNotIn('passwd ', source)
        self.assertNotIn("'restart'", source)
        self.assertIn("(SYSTEMCTL, 'reload', 'ssh.service')", source)

    def test_apply_validates_staged_effective_policy_before_replace_and_reloads_once(self):
        original = b'fixed-original-fixture'
        candidate = original + policy.SUFFIX
        base = b'pubkeyauthentication yes\npasswordauthentication yes\npermitrootlogin yes\n'
        hardened = (b'pubkeyauthentication yes\npasswordauthentication no\n'
                    b'permitrootlogin without-password\nauthenticationmethods publickey\n'
                    b'kbdinteractiveauthentication no\n')
        events = []
        replaced = [False]
        info = SimpleNamespace(st_dev=1, st_ino=2, st_size=len(original), st_mtime_ns=3,
                               st_ctime_ns=4)
        def snapshot(directory, name, size, digest, mode):
            events.append('snapshot:' + name)
            return ((candidate if replaced[0] else original) if name == 'sshd_config'
                    else original), info
        def runner(argv, seconds, limit):
            events.append('run:' + ' '.join(argv[:3]))
            if argv[:3] == (policy.SYSTEMCTL, 'reload', 'ssh.service'):
                return 0, b'', sha(b'')
            if '-T' in argv:
                return 0, hardened if 'user=root,' in argv[-1] else base, sha(b'')
            return 0, b'', sha(b'')
        def replace(*args, **kwargs):
            events.append('replace')
            replaced[0] = True
        def verify(*args):
            events.append('verify-staged-t-and-T')
            return {'after': [sha(hardened), sha(hardened), sha(base), sha(base)]}
        with ExitStack() as stack:
            stack.enter_context(mock.patch.object(policy.os, 'geteuid', return_value=0, create=True))
            stack.enter_context(mock.patch.object(policy, '_boot'))
            stack.enter_context(mock.patch.object(policy, '_directory', return_value=10))
            stack.enter_context(mock.patch.object(policy, '_snapshot', side_effect=snapshot))
            stack.enter_context(mock.patch.object(policy, 'planned_bytes', return_value=candidate))
            stack.enter_context(mock.patch.object(policy, '_absent'))
            stack.enter_context(mock.patch.object(policy, '_service', return_value=3431))
            stack.enter_context(mock.patch.object(policy, '_verify_candidate', side_effect=verify))
            stack.enter_context(mock.patch.object(policy, '_write_exclusive',
                                                  side_effect=lambda fd, name, data, mode:
                                                  events.append('write:' + name)))
            stack.enter_context(mock.patch.object(policy.os, 'replace', side_effect=replace))
            stack.enter_context(mock.patch.object(policy.os, 'stat', return_value=info))
            stack.enter_context(mock.patch.object(policy.os, 'fsync'))
            stack.enter_context(mock.patch.object(policy.os, 'close'))
            result = policy.run({'phase': 'start', 'candidateSha256': None}, runner=runner,
                                session='169.254.142.174 51000 169.254.220.254 22')
        self.assertLess(events.index('verify-staged-t-and-T'), events.index('replace'))
        self.assertEqual(events.count('run:/bin/systemctl reload ssh.service'), 1)
        self.assertEqual(result['serviceAction'], 'reload')

    def test_rollback_mismatched_live_config_does_not_write_or_reload(self):
        original = b'fixed-original-fixture'
        candidate = original + policy.SUFFIX
        info = SimpleNamespace(st_dev=1, st_ino=2, st_size=len(candidate), st_mtime_ns=3,
                               st_ctime_ns=4)
        def snapshot(directory, name, size, digest, mode):
            return (original if name == policy.BACKUP else candidate + b'X'), info
        with ExitStack() as stack:
            stack.enter_context(mock.patch.object(policy.os, 'geteuid', return_value=0, create=True))
            stack.enter_context(mock.patch.object(policy, '_boot'))
            stack.enter_context(mock.patch.object(policy, '_directory', return_value=10))
            stack.enter_context(mock.patch.object(policy, '_snapshot', side_effect=snapshot))
            stack.enter_context(mock.patch.object(policy, 'planned_bytes', return_value=candidate))
            write = stack.enter_context(mock.patch.object(policy, '_write_exclusive'))
            service = stack.enter_context(mock.patch.object(policy, '_service'))
            stack.enter_context(mock.patch.object(policy.os, 'close'))
            with self.assertRaisesRegex(ValueError, 'rollback-preimage-mismatch'):
                policy.rollback({'phase': 'start', 'candidateSha256': None},
                                session='169.254.142.174 51000 169.254.220.254 22')
        write.assert_not_called()
        service.assert_not_called()

    def test_rollback_validates_stage_before_replace_and_reloads_once(self):
        original = b'fixed-original-fixture'
        candidate = original + policy.SUFFIX
        base = (b'pubkeyauthentication yes\npasswordauthentication yes\n'
                b'permitrootlogin yes\n')
        events = []
        replaced = [False]
        info = SimpleNamespace(st_dev=1, st_ino=2, st_size=len(candidate), st_mtime_ns=3,
                               st_ctime_ns=4)
        def snapshot(directory, name, size, digest, mode):
            if name == policy.BACKUP:
                return original, info
            if name == 'sshd_config':
                return (original if replaced[0] else candidate), info
            return original, info
        def runner(argv, seconds, limit):
            events.append('run:' + ' '.join(argv[:3]))
            if '-T' in argv:
                return 0, base, sha(b'')
            return 0, b'', sha(b'')
        def replace(*args, **kwargs):
            events.append('replace')
            replaced[0] = True
        def verify(*args):
            events.append('verify-rollback-staged-t-and-T')
            return {'before': [sha(base)] * 4}
        with ExitStack() as stack:
            stack.enter_context(mock.patch.object(policy.os, 'geteuid', return_value=0, create=True))
            stack.enter_context(mock.patch.object(policy, '_boot'))
            stack.enter_context(mock.patch.object(policy, '_directory', return_value=10))
            stack.enter_context(mock.patch.object(policy, '_snapshot', side_effect=snapshot))
            stack.enter_context(mock.patch.object(policy, 'planned_bytes', return_value=candidate))
            stack.enter_context(mock.patch.object(policy, '_absent'))
            stack.enter_context(mock.patch.object(policy, '_service', return_value=3431))
            stack.enter_context(mock.patch.object(policy, '_verify_candidate', side_effect=verify))
            stack.enter_context(mock.patch.object(policy, '_write_exclusive',
                                                  side_effect=lambda fd, name, data, mode:
                                                  events.append('write:' + name)))
            stack.enter_context(mock.patch.object(policy.os, 'replace', side_effect=replace))
            stack.enter_context(mock.patch.object(policy.os, 'stat', return_value=info))
            stack.enter_context(mock.patch.object(policy.os, 'fsync'))
            stack.enter_context(mock.patch.object(policy.os, 'close'))
            result = policy.rollback({'phase': 'start', 'candidateSha256': None}, runner=runner,
                                     session='169.254.142.174 51000 169.254.220.254 22')
        self.assertLess(events.index('verify-rollback-staged-t-and-T'), events.index('replace'))
        self.assertEqual(events.count('run:/bin/systemctl reload ssh.service'), 1)
        self.assertTrue(result['remoteRootPasswordRouteRestored'])


if __name__ == '__main__':
    unittest.main()
