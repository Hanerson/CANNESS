import argparse
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('runner', Path(__file__).parents[1] / 'remote/runner.py')
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)

class Diagnostics(unittest.TestCase):
    def args(self, **kw):
        return argparse.Namespace(runs=20, compile_only=False, set_env='', device='7', bash='bash', lock='', build_timeout=10, run_timeout=10, msprof_timeout=10, msprof='msprof', **kw)

    def test_compile_only_needs_no_run_script(self):
        with tempfile.TemporaryDirectory() as directory:
            p = Path(directory)
            (p/'manifest.json').write_text(json.dumps({'generationId':'g'}))
            (p/'build.sh').touch()
            (p/'exe').touch()
            args=self.args(); args.compile_only=True
            with patch.object(r, 'run_command', return_value=subprocess.CompletedProcess([],0,str(p/'exe'),' ')), patch.object(r, 'inspect_environment', return_value={'toolchain':'selected compiler'}):
                report=r.evaluate(p,'g',args)
            self.assertTrue(report['compile']['ok'])
            self.assertEqual(report['runRecord']['params']['phase'],'compile-only')
            self.assertFalse(report['correctness']['ok'])
            self.assertEqual(report['runRecord']['toolchain'],'selected compiler')

    def test_failed_profiler_rejects_even_usable_csv(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(r,'run_command',return_value=subprocess.CompletedProcess([],3,'','failed')), patch.object(r,'profile_from_csv',return_value=({'op':{'taskDurationUs':1}},'')):
                profile,error,_=r.profile_executable(Path('exe'),Path(directory),self.args(),'','op',20)
            self.assertIsNone(profile)
            self.assertIn('exited 3',error)

    def test_version_uses_selected_shell_environment(self):
        with patch.object(r.shutil, 'which', return_value=None), patch.object(r, 'run_command', return_value=subprocess.CompletedProcess([],0,'Selected compiler 9','')) as command:
            self.assertEqual(r.toolchain_version('/missing', '/selected/bisheng', 'source selected; ', 'selected-bash'), 'Selected compiler 9')
            self.assertEqual(command.call_args.args[1], 'source selected; ')

    def test_profile_retains_raw_operator_statistic_columns(self):
        with tempfile.TemporaryDirectory() as directory:
            p = Path(directory)
            (p/'op_summary.csv').write_text('Op Name,Task Duration(us)\nop,5\n')
            (p/'op_statistic.csv').write_text('Op Name,Avg Time(us),aiv busy cycles,mte3 bytes\nop,5,42,128\n')
            profile, error = r.profile_from_csv(p, 'op')
            self.assertEqual(error, '')
            self.assertEqual(profile['opStatistic'][0]['mte3 bytes'], '128')

    def test_launch_config_fills_missing_block_dimension_with_explicit_source(self):
        with tempfile.TemporaryDirectory() as directory:
            profile = {'op': {'blockDim': None, 'taskType': 'AI_CORE'}, 'notCollected': ['blockDim']}
            r.enrich_launch_metadata(profile, Path(directory), {'blockDim': 40})
            self.assertEqual(profile['op']['blockDim'], 40)
            self.assertEqual(profile['op']['blockDimSource'], 'launch-config')
            self.assertNotIn('blockDim', profile['notCollected'])
            self.assertIsNone(profile['op']['kernelTaskType'])
            self.assertIn('kernelTaskType', profile['notCollected'])

    def test_profiler_block_dimension_has_priority_and_task_declaration_keeps_csv_label(self):
        with tempfile.TemporaryDirectory() as directory:
            p = Path(directory)
            (p/'op_kernel').mkdir()
            (p/'op_kernel/kernel.cpp').write_text('KERNEL_TASK_TYPE_DEFAULT(KERNEL_TYPE_AIV_ONLY);')
            profile = {'op': {'blockDim': 16, 'taskType': 'AI_CORE'}, 'notCollected': []}
            r.enrich_launch_metadata(profile, p, {'blockDim': 40})
            self.assertEqual(profile['op']['blockDim'], 16)
            self.assertEqual(profile['op']['blockDimSource'], 'msprof')
            self.assertEqual(profile['op']['taskType'], 'AI_CORE')
            self.assertEqual(profile['op']['kernelTaskType'], 'AIV')
            self.assertIn('op_kernel/kernel.cpp', profile['op']['kernelTaskTypeSource'])
            self.assertIn('KERNEL_TYPE_AIV_ONLY', profile['op']['kernelTaskTypeSource'])

    def test_kernel_task_metadata_ignores_comments_and_ambiguous_declarations(self):
        with tempfile.TemporaryDirectory() as directory:
            p = Path(directory)
            (p/'op_kernel').mkdir()
            source = p/'op_kernel/kernel.cpp'
            for body, expected in [
                ('// KERNEL_TASK_TYPE_DEFAULT(KERNEL_TYPE_AIV_ONLY);', None),
                ('const char* s = "KERNEL_TASK_TYPE_DEFAULT(KERNEL_TYPE_AIV_ONLY)";', None),
                ('KERNEL_TASK_TYPE_DEFAULT(KERNEL_TYPE_AIC_ONLY);', 'AIC'),
                ('KERNEL_TASK_TYPE_DEFAULT(KERNEL_TYPE_AIC_ONLY); KERNEL_TASK_TYPE_DEFAULT(KERNEL_TYPE_AIV_ONLY);', None),
            ]:
                source.write_text(body)
                profile = {'op': {'blockDim': None, 'taskType': 'AI_CORE'}, 'notCollected': ['blockDim']}
                r.enrich_launch_metadata(profile, p, {'blockDim': -1})
                self.assertEqual(profile['op']['kernelTaskType'], expected)
                self.assertIsNone(profile['op']['blockDim'])

    def test_failed_contract_selfcheck_warns_but_does_not_block_the_user_build(self):
        with tempfile.TemporaryDirectory() as directory:
            p = Path(directory)
            (p/'manifest.json').write_text(json.dumps({'generationId': 'g'}))
            (p/'build.sh').touch()
            (p/'run_once.sh').touch()
            (p/'exe').touch()
            selfcheck = p/'.contract-selfcheck'
            selfcheck.mkdir()
            (selfcheck/'build.sh').touch()

            def run_command(argv, *a, **kw):
                if any('.contract-selfcheck' in str(item) for item in argv):
                    return subprocess.CompletedProcess(argv, 1, '', 'selfcheck boom')
                return subprocess.CompletedProcess(argv, 0, str(p/'exe'), '')

            args = self.args()
            args.compile_only = True
            with patch.object(r, 'run_command', side_effect=run_command), \
                    patch.object(r, 'inspect_environment', return_value={'toolchain': 't'}):
                report = r.evaluate(p, 'g', args)
            self.assertEqual(report['status'], 'pass')
            self.assertFalse(report['runRecord']['params']['contractSelfCheck']['ok'])
            self.assertIn('selfcheck boom', report['compile']['log'])
            self.assertIn('contract self-check failed', report['summary'])

    def test_missing_and_uncollected_metrics_are_explicit(self):
        mapping=r.column_map(['Task Duration(us)','aicore_time(us)','aic_mac_ratio','aic_mte2_ratio','aic_scalar_ratio'])
        row={v:'0' for v in mapping.values()}
        profile=r.build_profile([5],[row],mapping,'op','test')
        self.assertIsNone(profile['op']['aicoreTimeUs'])
        self.assertIn('aicoreTimeUs',profile['notCollected'])
        self.assertIn('blockDim',profile['notCollected'])
        self.assertIsNone(profile['op']['aicMacRatio'])

if __name__ == '__main__': unittest.main()
