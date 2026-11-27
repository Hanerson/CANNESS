import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).parents[1] / 'remote' / 'retention.py'
GENERATION = 'gen-test'


class RetentionTests(unittest.TestCase):
    def invoke(self, *args):
        result = subprocess.run([sys.executable, str(SCRIPT), *map(str, args)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def write_result(self, path, timestamp, payload):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload), encoding='utf-8')
        os.utime(path, (timestamp, timestamp))

    def attempt_name(self, prefix, number):
        return f'{prefix}-00000000-0000-4000-8000-{number:012x}'

    def test_keeps_newest_completed_eval_pairs_and_current(self):
        with tempfile.TemporaryDirectory(prefix='gc-') as directory:
            base = Path(directory)
            inbox, outbox = base / 'in', base / 'out'
            report = {'status': 'pass', 'generationId': GENERATION}
            names = [self.attempt_name('attempt', number) for number in range(5)]
            for index, name in enumerate(names):
                (inbox / GENERATION / name).mkdir(parents=True)
                marker = outbox / GENERATION / name / GENERATION / 'results.json'
                if index < 3:
                    self.write_result(marker, index + 1, report)
                elif index == 4:
                    marker.parent.mkdir(parents=True)
                    marker.write_text('{', encoding='utf-8')
            unknown = inbox / GENERATION / 'attempt-user-data'
            unknown.mkdir()

            self.invoke('eval', '--inbox', inbox, '--outbox', outbox, '--generation', GENERATION,
                        '--current', names[0], '--keep', 1)
            self.assertFalse((inbox / GENERATION / names[1]).exists())
            self.assertFalse((outbox / GENERATION / names[1]).exists())
            self.assertTrue((outbox / GENERATION / names[0]).is_dir())
            self.assertTrue((outbox / GENERATION / names[2]).is_dir())
            self.assertEqual({path.name for path in (inbox / GENERATION).iterdir()}, set(names) - {names[1]} | {unknown.name})

    def test_validation_cleanup_touches_only_completed_validation_attempts(self):
        with tempfile.TemporaryDirectory(prefix='gc-') as directory:
            inbox = Path(directory)
            names = [self.attempt_name('submission-validation', number) for number in range(3)]
            for index, name in enumerate(names[:2]):
                self.write_result(inbox / name / 'validation-result.json', index + 1, {'status': 'failed'})
            (inbox / names[2]).mkdir()
            unrelated = inbox / 'submission-validation-manual'
            self.write_result(unrelated / 'validation-result.json', 1, {'status': 'installed'})

            args = ('validation', '--inbox', inbox, '--current', names[1])
            self.invoke(*args, '--keep', 0)
            self.assertTrue((inbox / names[0]).is_dir())
            self.invoke(*args, '--keep', 1)
            self.invoke(*args, '--keep', 1)
            self.assertEqual({path.name for path in inbox.iterdir()}, {names[1], names[2], unrelated.name})

    def symlink(self, link, target, *, directory=False):
        try:
            link.symlink_to(target, target_is_directory=directory)
        except OSError as error:
            if sys.platform == 'win32' and error.winerror == 1314:
                self.skipTest('Windows requires symlink privilege')
            raise

    def test_does_not_traverse_linked_roots_attempts_or_completion_markers(self):
        with tempfile.TemporaryDirectory(prefix='gc-') as directory:
            root = Path(directory)
            inbox = root / 'real' / 'in'
            inbox.mkdir(parents=True)
            alias = root / 'alias'
            self.symlink(alias, inbox.parent, directory=True)
            names = [self.attempt_name('submission-validation', number) for number in range(4)]
            first, second, linked_dir, linked_marker = [inbox / name for name in names]
            self.write_result(first / 'validation-result.json', 1, {'status': 'validated'})
            self.write_result(second / 'validation-result.json', 2, {'status': 'validated'})
            self.symlink(linked_dir, first, directory=True)
            linked_marker.mkdir()
            self.symlink(linked_marker / 'validation-result.json', first / 'validation-result.json')

            self.invoke('validation', '--inbox', alias / 'in', '--current', names[1], '--keep', 1)
            self.assertTrue(first.is_dir())
            self.invoke('validation', '--inbox', inbox, '--current', names[1], '--keep', 1)
            self.assertFalse(first.exists())
            self.assertTrue(linked_dir.is_symlink())
            self.assertTrue((linked_marker / 'validation-result.json').is_symlink())


if __name__ == '__main__':
    unittest.main()
