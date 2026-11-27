import argparse
import hashlib
import importlib.util
import io
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
        with patch.object(r, 'run_command', return_value=subprocess.CompletedProcess([], 0, 'Selected compiler 9', '')) as command:
            self.assertEqual(r.compiler_version('/selected/bisheng', 'source selected; ', 'selected-bash'), 'Selected compiler 9')
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

    def test_preflight_reports_versions_and_warns_on_soc_mismatch_without_blocking(self):
        with tempfile.TemporaryDirectory() as directory:
            toolkit = Path(directory)
            (toolkit / 'compiler').mkdir()
            (toolkit / 'compiler' / 'version.info').write_text('Version=9.2.1\n')
            set_env = toolkit / 'set_env.sh'
            set_env.touch()
            args = self.args()
            args.set_env = str(set_env)
            compiler = toolkit / 'bin' / 'bisheng'
            inspected = subprocess.CompletedProcess(
                [], 0, f'banner\n{toolkit}\n{compiler}\n/path/msprof\nascend910b1\n', '')

            def run_command(argv, *other_args, **kwargs):
                if argv[0] == 'npu-smi':
                    return subprocess.CompletedProcess(argv, 0, 'Chip Name : Ascend910B2\n', '')
                return subprocess.CompletedProcess(argv, 0, 'clang version 15.0.5\n', '')

            with patch.object(r.subprocess, 'run', return_value=inspected), \
                    patch.object(r, 'run_command', side_effect=run_command), \
                    patch('sys.stdout', new_callable=io.StringIO) as stdout:
                r.preflight(args)
            facts = json.loads(stdout.getvalue())
            self.assertTrue(facts['ready'])
            self.assertEqual(facts['cannVersion'], '9.2.1')
            self.assertEqual(facts['compilerVersion'], 'clang version 15.0.5')
            self.assertEqual(facts['toolkitHome'], str(toolkit))
            self.assertEqual(facts['toolchain'], 'clang version 15.0.5')
            self.assertEqual(facts['socVersionEnv'], 'ascend910b1')
            self.assertEqual(facts['detectedSoc'], 'Ascend910B2')
            self.assertTrue(any('ascend910b1' in issue and 'Ascend910B2' in issue for issue in facts['issues']))

    def test_profile_retains_raw_operator_statistic_columns(self):
        with tempfile.TemporaryDirectory() as directory:
            p = Path(directory)
            (p/'op_summary.csv').write_text('Op Name,Task Duration(us)\nop,5\n')
            (p/'op_statistic.csv').write_text('Op Name,Avg Time(us),aiv busy cycles,mte3 bytes\nop,5,42,128\n')
            profile, error = r.profile_from_csv(p, 'op')
            self.assertEqual(error, '')
            self.assertEqual(profile['opStatistic'][0]['mte3 bytes'], '128')

    def test_profile_keeps_exact_kernel_and_operator_matches(self):
        with tempfile.TemporaryDirectory() as directory:
            p = Path(directory)
            (p / 'op_summary.csv').write_text(
                'Op Name,Op Type,Task Duration(us)\n'
                'canness_kernel,AI_CORE,5\nApplyRotaryPosEmb,AI_CORE,7\n'
                'canness_kernel_setup,AI_CORE,70\nApplyRotaryPosEmbInit,AI_CORE,90\n')
            profile, error = r.profile_from_csv(p, 'ApplyRotaryPosEmb')
            self.assertEqual(error, '')
            self.assertEqual(profile['op']['taskDurationUs'], 6)

    def test_profile_rejects_unrelated_summary_and_statistic_rows(self):
        with tempfile.TemporaryDirectory() as directory:
            p = Path(directory)
            (p / 'op_summary.csv').write_text('Op Name,Task Duration(us)\nPrepare,10\nCopy,50\n')
            (p / 'op_statistic.csv').write_text('Op Name,Avg Time(us)\nFinalize,20\n')
            profile, error = r.profile_from_csv(p, 'ApplyRotaryPosEmb')
            self.assertIsNone(profile)
            for name in ('ApplyRotaryPosEmb', 'canness_kernel', 'Prepare', 'Copy', 'Finalize'):
                self.assertIn(name, error)

    def test_profile_statistic_fallback_keeps_only_exact_matches(self):
        with tempfile.TemporaryDirectory() as directory:
            p = Path(directory)
            (p / 'op_summary.csv').write_text('Op Name,Task Duration(us)\nPrepare,10\n')
            (p / 'op_statistic.csv').write_text('Op Name,Avg Time(us)\ncanness_kernel,8\nCopy,50\n')
            profile, error = r.profile_from_csv(p, 'ApplyRotaryPosEmb')
            self.assertEqual(error, '')
            self.assertEqual(profile['op']['taskDurationUs'], 8)
            self.assertEqual([row['Op Name'] for row in profile['opStatistic']], ['canness_kernel'])

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

    def evaluate_stdout(self, stdout, *, stderr='', returncode=0, accuracy_only=False, chip='Ascend910B2'):
        with tempfile.TemporaryDirectory() as directory:
            package = Path(directory)
            tensor = {'shape': ['64'], 'dtype': 'float16'}
            manifest = {'generationId': 'g', 'operatorName': 'op', 'performanceTargetUs': 1,
                        'chip': chip, 'tensorSpecs': {'inputs': [tensor], 'outputs': [tensor]}}
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

    def test_unconfigured_chip_has_an_explicit_roofline_reason(self):
        report = self.evaluate_stdout('CANNESS_RESULT {"badCount":0,"maxAbsErr":0}\n')
        analysis = report['analysis']
        self.assertIsNone(analysis['rooflineUs'])
        self.assertIn('peak bandwidth is not configured for Ascend910B2', analysis['summary'])
        self.assertAlmostEqual(analysis['achievedBandwidthGBps'], 0.0512)

    def test_original_ascend_910_keeps_its_roofline(self):
        report = self.evaluate_stdout('CANNESS_RESULT {"badCount":0,"maxAbsErr":0}\n', chip='Ascend910')
        self.assertAlmostEqual(report['analysis']['rooflineUs'], 256 / 1_200_000)

    def test_reports_build_timeout_missing_executable_missing_result_and_malformed_manifest(self):
        for scenario, expected_status, summary in [
                ('build-timeout', 'compile_fail', 'build.sh timed out'),
                ('missing-executable', 'compile_fail', 'build.sh reported a missing executable'),
                ('missing-result', 'error', 'run_once.sh did not print a CANNESS_RESULT line'),
                ('malformed-manifest', 'error', 'malformed manifest.json'),
                ('run-timeout', 'timeout', 'run_once.sh timed out')]:
            with self.subTest(scenario=scenario), tempfile.TemporaryDirectory() as directory:
                package = Path(directory)
                manifest = '{' if scenario == 'malformed-manifest' else '{"generationId":"g"}'
                (package / 'manifest.json').write_text(manifest)
                for name in ('build.sh', 'run_once.sh', 'exe'):
                    (package / name).touch()

                def command(argv, env, timeout, **kwargs):
                    build = str(argv[1]).endswith('build.sh')
                    if (build and scenario == 'build-timeout') or (not build and scenario == 'run-timeout'):
                        raise subprocess.TimeoutExpired(argv, timeout)
                    stdout = ('missing\n' if scenario == 'missing-executable' else 'exe\n') if build else ''
                    return subprocess.CompletedProcess(argv, 0, stdout, '')

                with patch.object(r, 'run_command', side_effect=command), \
                        patch.object(r, 'inspect_environment', return_value={'toolchain': 't'}):
                    report = r.evaluate(package, 'g', self.args())
                self.assertEqual(report['status'], expected_status)
                self.assertIn(summary, report['summary'])

    def test_total_budget_caps_self_check_and_build_and_prevents_accuracy_after_expiry(self):
        with tempfile.TemporaryDirectory() as directory:
            package = Path(directory)
            (package / 'manifest.json').write_text('{"generationId":"g"}')
            for name in ('build.sh', 'run_once.sh', 'exe'):
                (package / name).touch()
            selfcheck = package / '.contract-selfcheck'
            selfcheck.mkdir()
            (selfcheck / 'build.sh').touch()
            now = 30.0
            phases = []

            def command(argv, env, timeout, **kwargs):
                nonlocal now
                phases.append((Path(argv[1]).parent.name, timeout))
                now += 2
                return subprocess.CompletedProcess(argv, 0, 'exe\n', '')

            with patch.object(r, 'run_command', side_effect=command), \
                    patch.object(r, 'inspect_environment', return_value={'toolchain': 't'}), \
                    patch.object(r.time, 'monotonic', side_effect=lambda: now):
                report = r.evaluate(package, 'g', self.args(budget_sec=3))
            self.assertEqual(phases, [('.contract-selfcheck', 3), (package.name, 1)])
            self.assertEqual(report['status'], 'timeout')
            self.assertIn('run_once.sh', report['summary'])

    def test_profile_timeout_preserves_successful_build_and_accuracy(self):
        with tempfile.TemporaryDirectory() as directory:
            package = Path(directory)
            (package / 'manifest.json').write_text('{"generationId":"g"}')
            for name in ('build.sh', 'run_once.sh', 'exe'):
                (package / name).touch()
            now = 30.0
            timeouts = []

            def command(argv, env, timeout, **kwargs):
                nonlocal now
                timeouts.append(timeout)
                now += 2
                if argv[0] == 'msprof':
                    raise subprocess.TimeoutExpired(argv, timeout)
                if Path(argv[1]).name == 'build.sh':
                    return subprocess.CompletedProcess(argv, 0, 'exe\n', '')
                return subprocess.CompletedProcess(argv, 0, 'CANNESS_RESULT {"badCount":0,"maxAbsErr":0}\n', '')

            with patch.object(r, 'run_command', side_effect=command), \
                    patch.object(r, 'inspect_environment', return_value={'toolchain': 't'}), \
                    patch.object(r.time, 'monotonic', side_effect=lambda: now):
                report = r.evaluate(package, 'g', self.args(budget_sec=5))
            self.assertEqual(timeouts, [5, 3, 1])
            self.assertEqual(report['status'], 'timeout')
            self.assertTrue(report['compile']['ok'])
            self.assertTrue(report['correctness']['ok'])
            self.assertEqual(report['summary'], 'msprof timed out after 1s')

    def test_reports_device_unavailable_separately_from_candidate_faults(self):
        unavailable = self.evaluate_stdout('', stderr='CANNESS_ERROR: no visible NPU devices\n', returncode=1)
        self.assertEqual(unavailable['status'], 'error')
        self.assertEqual(unavailable['runRecord']['params'].get('failureKind'), 'device_unavailable')
        fault = self.evaluate_stdout('', stderr='CANNESS_ERROR: vector core exception\n', returncode=1)
        self.assertEqual(fault['status'], 'error')
        self.assertNotIn('failureKind', fault['runRecord']['params'])

    def test_runtime_failure_preserves_a_device_diagnostic_before_a_long_tail(self):
        fault = self.evaluate_stdout('CANNESS_ERROR: vector core exception\n' + ('noise\n' * 5000), returncode=1)
        self.assertIn('CANNESS_ERROR: vector core exception', fault['compile']['log'])

    def test_build_evidence_uses_authoritative_script_and_stdout(self):
        with tempfile.TemporaryDirectory() as directory:
            package = Path(directory)
            script = b'#!/usr/bin/env bash\n# edited build script\n'
            sha = hashlib.sha256(script).hexdigest()
            (package / 'build.sh').write_bytes(script)
            (package / 'exe').touch()
            selfcheck = package / '.contract-selfcheck'
            selfcheck.mkdir()
            (selfcheck / 'build.sh').touch()

            def command(argv, *args, **kwargs):
                if Path(argv[1]).parent == selfcheck:
                    return subprocess.CompletedProcess(argv, 0, 'CANNESS_BUILD dialect=legacy\n', '')
                return subprocess.CompletedProcess(argv, 0,
                    'CANNESS_BUILD dialect=npu_arch\nCANNESS_BUILD npu_arch=dav-2201\n'
                    'CANNESS_BUILD soc=Ascend910B2\nCANNESS_BUILD flags=-x asc --npu-arch=dav-2201\nexe\n', '')

            for baseline, source in [(sha, 'template'), ('0' * 64, 'override'), (None, 'unknown')]:
                with self.subTest(source=source):
                    manifest = {'generationId': 'g'}
                    if baseline is not None:
                        manifest['buildScript'] = {'defaultSha256': baseline}
                    (package / 'manifest.json').write_text(json.dumps(manifest))
                    args = self.args()
                    args.compile_only = True
                    with patch.object(r, 'run_command', side_effect=command), \
                            patch.object(r, 'inspect_environment', return_value={'toolchain': 't'}):
                        report = r.evaluate(package, 'g', args)
                    self.assertEqual(report['status'], 'pass')
                    self.assertEqual(report['runRecord']['params'].get('build'), {
                        'source': source, 'scriptSha256': sha, 'dialect': 'npu_arch',
                        'npu_arch': 'dav-2201', 'soc': 'Ascend910B2', 'flags': '-x asc --npu-arch=dav-2201'})

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
