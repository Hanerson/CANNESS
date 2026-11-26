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

    def test_device_and_lock_overrides_preserve_default_and_explicit_empty_lock(self):
        with patch.dict(r.os.environ, {}, clear=True):
            self.assertEqual(r.resolve_device_settings(), ('7', '/tmp/canness/davinci7.lock'))
            self.assertEqual(r.resolve_device_settings('2'), ('2', '/tmp/canness/davinci2.lock'))
            self.assertEqual(r.resolve_device_settings('2', ''), ('2', ''))
            self.assertEqual(r.resolve_device_settings('2,3'), ('2,3', '/tmp/canness/davinci7.lock'))
        with patch.dict(r.os.environ, {'CANNESS_ASCEND_VISIBLE_DEVICES': '3', 'CANNESS_DAVINCI_LOCK': '/tmp/custom.lock'}):
            self.assertEqual(r.resolve_device_settings(), ('3', '/tmp/custom.lock'))
            self.assertEqual(r.resolve_device_settings('5'), ('5', '/tmp/custom.lock'))

    def test_toolkit_discovery_preserves_the_submission_environment_fallback(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            toolkit = base / 'alternate'
            toolkit.mkdir()
            fallback = toolkit / 'set_env.sh'
            fallback.touch()
            with patch.dict(r.os.environ, {'ASCEND_HOME_PATH': str(toolkit)}), \
                    patch.object(r, 'SYSTEM_SET_ENV', str(base / 'missing-system')):
                selected, searched = r.discover_set_env('', home=base, toolkit_home='')
                self.assertEqual(selected, str(fallback))
                self.assertIn(str(fallback), searched)

    def test_detect_soc_requires_product_evidence_for_selected_board(self):
        args = self.args()
        for output, expected in [('Chip Name : Ascend910_9362\n', 'Ascend910_9362'),
                                 ('NPU Name : 910B2\n', 'Ascend910B2'),
                                 ('Chip Name : Ascend910\nNPU Name : 9362\n', 'Ascend910_9362'),
                                 ('Name : board rev B\n', None),
                                 ('Chip Name : 910B2\nSoC Version : 950PR\n', None)]:
            with self.subTest(output=output):
                with patch.object(r, 'run_command', return_value=subprocess.CompletedProcess([], 0, output, '')) as command:
                    self.assertEqual(r.detect_soc(args, None), expected)
                    self.assertEqual(command.call_args_list[0].args[0], ['npu-smi', 'info', '-t', 'board', '-i', '7'])

    def test_detect_soc_can_read_the_selected_npu_from_the_summary_table(self):
        outputs = [subprocess.CompletedProcess([], 1, '', 'unsupported'), subprocess.CompletedProcess(
            [], 0, '| 2     910B4 | OK |\n| 7     910B2 | OK |\n', '')]
        with patch.object(r, 'run_command', side_effect=outputs):
            self.assertEqual(r.detect_soc(self.args(), None), 'Ascend910B2')

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

    def evaluate_stdout(self, stdout, *, stderr='', returncode=0, accuracy_only=False):
        with tempfile.TemporaryDirectory() as directory:
            package = Path(directory)
            manifest = {'generationId': 'g', 'operatorName': 'op', 'performanceTargetUs': 1}
            config = {'blockDim': 2, 'tileSize': 64,
                      'launch': {'block_dim': 2, 'tile_length': 64, 'workspace_bytes': 0},
                      'requestedLaunch': {'tile_length': 64}}
            (package / 'manifest.json').write_text(json.dumps(manifest))
            (package / 'config.json').write_text(json.dumps(config))
            for name in ('build.sh', 'run_once.sh', 'exe'):
                (package / name).touch()
            summary = package / 'op_summary.csv'
            summary.write_text('Op Name,Task Duration(us),aic_scalar_ratio\nop,5,0.95\n')

            def command(argv, *args, **kwargs):
                if str(argv[1]).endswith('build.sh'):
                    return subprocess.CompletedProcess(argv, 0, 'exe\n', '')
                if str(argv[1]).endswith('run_once.sh'):
                    return subprocess.CompletedProcess(argv, returncode, stdout, stderr)
                self.fail(f'unexpected command: {argv}')

            profile, error = r.profile_from_csv(package, 'op')
            with patch.object(r, 'run_command', side_effect=command), \
                    patch.object(r, 'inspect_environment', return_value={'toolchain': 't'}), \
                    patch.object(r, 'profile_executable', return_value=(profile, error, '')) as profiler:
                report = r.evaluate(package, 'g', self.args(accuracy_only=accuracy_only))
                if accuracy_only:
                    profiler.assert_not_called()
                return report

    def test_reports_weighted_call_budget_and_keeps_geometry_distinct_from_launch_config(self):
        report = self.evaluate_stdout(
            'CANNESS_RESULT {"badCount":0,"total":17,"maxAbsErr":0,"maxRelErr":0}\n'
            'CANNESS_TILING_REPORT {"geometry":{"runRows":3,"cosWindowElements":384},'
            '"kernelBudget":{"elementBasis":"query elements","blocks":['
            '{"blockIndex":1,"level2Calls":1,"elements":2,"callElements":2},'
            '{"blockIndex":0,"level2Calls":3,"elements":14,"callElements":30}]}}\n'
        )
        self.assertEqual(report['status'], 'perf_fail')
        params = report['runRecord']['params']
        self.assertEqual(params['launch'], {'block_dim': 2, 'tile_length': 64, 'workspace_bytes': 0})
        self.assertEqual(params['requestedLaunch'], {'tile_length': 64})
        self.assertEqual(params['tiling'], {'runRows': 3, 'cosWindowElements': 384})
        budget = report['analysis']['kernelBudget']
        self.assertEqual(params['kernelBudget'], budget)
        self.assertEqual(budget['source'], 'correctness-stdout')
        self.assertEqual(budget['elementBasis'], 'query elements')
        self.assertEqual([block['level2Calls'] for block in budget['blocks']], [3, 1])
        self.assertEqual((budget['level2Calls'], budget['elements'], budget['callElements']), (4, 16, 32))
        self.assertEqual((budget['perElementCalls'], budget['averageElementsPerCall']), (0.25, 8))
        self.assertIn('grouping more elements per Level-2 call', report['analysis']['summary'])

    def test_uses_no_budget_for_missing_invalid_ambiguous_or_unsuccessful_stdout(self):
        success = 'CANNESS_RESULT {"badCount":0,"maxAbsErr":0}\n'
        geometry = 'CANNESS_TILING_REPORT {"geometry":{"runRows":3}}\n'
        for diagnostic in [
            '', 'CANNESS_TILING_REPORT {\n', geometry + geometry,
            'CANNESS_TILING_REPORT {"geometry":{"runRows":NaN}}\n',
            'CANNESS_TILING_REPORT {"geometry":{"runRows":2,"runRows":1}}\n',
            'CANNESS_TILING_REPORT ' + (' ' * 20000) + '{"geometry":{"runRows":3}}\n',
            'CANNESS_TILING_REPORT {"kernelBudget":{"elementBasis":"x","blocks":[{'
            '"blockIndex":0,"level2Calls":0,"elements":2,"callElements":0}]}}\n',
        ]:
            with self.subTest(diagnostic=diagnostic[:80]):
                report = self.evaluate_stdout(success + diagnostic, stderr=geometry)
                self.assertEqual(report['status'], 'perf_fail')
                self.assertNotIn('kernelBudget', report['analysis'])
                self.assertNotIn('tiling', report['runRecord']['params'])

        for stdout, returncode, status in [(success, 1, 'error'),
                                           ('CANNESS_RESULT {"badCount":1,"maxAbsErr":1}\n', 0, 'accuracy_fail')]:
            report = self.evaluate_stdout(stdout + geometry, returncode=returncode)
            self.assertEqual(report['status'], status)
            self.assertNotIn('tiling', report['runRecord']['params'])

    def test_accuracy_only_preserves_comparison_without_profiling(self):
        accuracy = 'CANNESS_RESULT {"badCount":0,"total":17,"maxAbsErr":0.0001,"maxRelErr":0.0002}\n'
        report = self.evaluate_stdout(accuracy, accuracy_only=True)
        self.assertEqual(report['status'], 'pass')
        self.assertEqual(report['correctness'], {'ok': True, 'maxRelativeError': 0.0002})
        self.assertIsNone(report['performance']['kernelTimeUs'])
        self.assertIsNone(report['analysis'])
        self.assertIn('accuracy-only', report['summary'])
        params = report['runRecord']['params']
        self.assertEqual(params['phase'], 'accuracy-only')
        self.assertEqual((params['badCount'], params['total'], params['maxAbsErr']), (0, 17, 0.0001))
        self.assertIsNone(params['phaseTimingsMs']['profileMs'])

        failed = self.evaluate_stdout(accuracy.replace('"badCount":0', '"badCount":2'), accuracy_only=True)
        self.assertEqual(failed['status'], 'accuracy_fail')
        self.assertEqual(failed['runRecord']['params']['badCount'], 2)

if __name__ == '__main__': unittest.main()
