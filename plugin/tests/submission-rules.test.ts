import { expect, test } from 'vitest'
import { describeFindings, lintSubmissionSources } from '../src/submission-rules.ts'

const launcher = (copy: string) => [
  'extern "C" int canness_launch(void* stream, void* tilingDevice) {',
  copy,
  '  canness_kernel<<<1, nullptr, stream>>>(tilingDevice);',
  '  return 0;',
  '}',
].join('\n')

test('a cached, drained upload passes the rules', () => {
  const report = lintSubmissionSources({
    'csrc/launch.cpp': launcher([
      '  if (CannessTilingChanged(tilingDevice, host)) {',
      '    aclrtSynchronizeDevice();',
      '    aclrtMemcpy(tilingDevice, capacity, host.data(), host.size(), ACL_MEMCPY_HOST_TO_DEVICE);',
      '  }',
    ].join('\n')),
    'cann_bench/__init__.py': 'def _tiling_buffer(device):\n    pass\n',
  })
  expect(report.findings).toEqual([])
  expect(report.ok).toBe(true)
})

test('a per-launch copy is rejected with the scorer rule that zeroes the operator', () => {
  const report = lintSubmissionSources({
    'csrc/launch.cpp': launcher(
      '  aclrtMemcpy(tilingDevice, capacity, host.data(), host.size(), ACL_MEMCPY_HOST_TO_DEVICE);'),
  })
  expect(report.ok).toBe(false)
  expect(report.findings.map(finding => finding.rule)).toContain('aclrtmemcpy-budget')
  expect(describeFindings(report.findings)).toContain('uploads the tiling block once')
})

test('an unguarded copy behind a cache but without the drain is rejected', () => {
  const report = lintSubmissionSources({
    'csrc/launch.cpp': launcher([
      '  if (CannessTilingChanged(tilingDevice, host)) {',
      '    aclrtMemcpy(tilingDevice, capacity, host.data(), host.size(), ACL_MEMCPY_HOST_TO_DEVICE);',
      '  }',
    ].join('\n')),
  })
  expect(report.ok).toBe(false)
  expect(report.findings.map(finding => finding.rule)).toContain('aclrtmemcpy-ordering')
})

test('two copies are rejected even when both sit behind the cache', () => {
  const report = lintSubmissionSources({
    'csrc/launch.cpp': launcher([
      '  if (CannessTilingChanged(tilingDevice, host)) {',
      '    aclrtSynchronizeDevice();',
      '    aclrtMemcpy(tilingDevice, capacity, host.data(), host.size(), ACL_MEMCPY_HOST_TO_DEVICE);',
      '    aclrtMemcpyAsync(tilingDevice, capacity, host.data(), host.size(), ACL_MEMCPY_HOST_TO_DEVICE, stream);',
      '  }',
    ].join('\n')),
  })
  expect(report.ok).toBe(false)
  expect(report.findings[0]?.rule).toBe('aclrtmemcpy-budget')
})

test('a tiling block allocated inside the callable is rejected', () => {
  const report = lintSubmissionSources({
    'cann_bench/__init__.py': [
      'def op(x):',
      '    tiling = _torch.empty((4096,), dtype=_torch.uint8, device=x.device)',
      '    canness_launch(tiling.data_ptr())',
    ].join('\n'),
  })
  expect(report.ok).toBe(false)
  expect(report.findings.map(finding => finding.rule)).toContain('tiling-lifetime')
})

test('non UTF-8 sources are rejected before the validator has to', () => {
  const report = lintSubmissionSources({
    'cann_bench/__init__.py': Buffer.from([0xff, 0xfe, 0x22, 0x22, 0x22]),
  })
  expect(report.ok).toBe(false)
  expect(report.findings[0]?.rule).toBe('utf8')
})


