import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { buildTestPackage, writeOperator } from '../src/package-files.ts'
import { parseSpec } from '../src/spec.ts'
import { exportSubmission } from '../src/submission.ts'

const base = {
  operator_name: 'rotary',
  operator_type: 'elementwise',
  input_specs: [{ name: 'input', shape: ['16'], dtype: 'float32' }],
  output_specs: [{ name: 'out', shape: ['16'], dtype: 'float32' }],
  attrs: { layout: 0, mode: 'half' },
  interface: { attrs: ['layout', 'mode'], dtypes: ['fp32', 'bf16'] },
  target_platform: { chip: 'Ascend910B2' },
  performance_target: { metric: 'kernel_time', target_us: 50 },
}

const support = {
  configurations: [
    { dtype: 'fp32', attrs: { layout: 0, mode: 'half' } },
    { dtype: 'bf16', attrs: { layout: 1, mode: 'interleaved' } },
  ],
  min_align_bytes: 32,
}

test('declared support validates rows, normalizes dtypes, and rejects unknown attrs', () => {
  expect(parseSpec({ ...base, support }).support).toEqual({
    ...support, configurations: [
      { ...support.configurations[0], dtype: 'float32' },
      { ...support.configurations[1], dtype: 'bfloat16' },
    ],
  })
  expect(() => parseSpec({ ...base, support: { configurations: [{ attrs: { rotated: true } }] } }))
    .toThrow(/support.*rotated/)
  expect(() => parseSpec({ ...base, support: { configurations: [{ dtype: 'int64' }] } }))
    .toThrow(/support.*dtype/)
  expect(() => parseSpec({ ...base, support: { min_align_bytes: 30 } })).toThrow(/power of two/)
  const custom = { wrapper_attrs: ['rotaryMode'], configurations: [{ attrs: { rotaryMode: 'interleaved' } }] }
  expect(parseSpec({ ...base, support: custom }).support).toEqual(custom)
})

const python = ['python3', 'python'].find(executable => spawnSync(executable, ['--version']).status === 0)
const testWithPython = python ? test : test.skip
testWithPython('generated wrapper rejects undeclared combinations and misalignment before allocating outputs', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'canness-support-'))
  try {
    const generation = 'gen-87654321'
    const spec = parseSpec({ ...base, support })
    writeOperator(workspace, generation, {
      kernel: 'extern "C" __global__ __aicore__ void canness_kernel(GM_ADDR x, GM_ADDR out, GM_ADDR tiling) {}',
      host: '', api: '', plugin: '',
    })
    buildTestPackage(workspace, generation, spec)
    const { sourceDir } = exportSubmission(workspace, generation, spec)
    const provenance = JSON.parse(readFileSync(join(sourceDir, 'provenance.json'), 'utf8'))
    expect(provenance.support).toEqual(spec.support)
    const harness = join(workspace, 'check.py')
    writeFileSync(harness, [
      'import ctypes, runpy, sys, types',
      'from contextlib import nullcontext',
      'with_calls = []',
      'class Device:',
      '    type = "npu"',
      'class FakeTensor:',
      '    device = Device()',
      '    shape = (16,)',
      '    def __init__(self, dtype, address=32):',
      '        self.dtype, self.address = dtype, address',
      '    def is_contiguous(self): return True',
      '    def numel(self): return 0',
      '    def data_ptr(self): return self.address',
      'def empty(*args, **kwargs):',
      '    with_calls.append(kwargs["dtype"])',
      '    return FakeTensor(kwargs["dtype"])',
      'sys.modules["torch"] = types.SimpleNamespace(float32="torch.float32", bfloat16="torch.bfloat16", empty=empty)',
      'sys.modules["torch_npu"] = types.SimpleNamespace(npu=types.SimpleNamespace(device=lambda _x: nullcontext()))',
      'ctypes.CDLL = lambda _path: types.SimpleNamespace(canness_launch=lambda *args: 0)',
      'module = runpy.run_path(sys.argv[1])',
      'rotary, unsupported = module["rotary"], module["UnsupportedConfiguration"]',
      'rotary(FakeTensor("torch.float32"), 0, "half")',
      'rotary(FakeTensor("torch.bfloat16"), 1, "interleaved")',
      'for tensor, layout, mode in [(FakeTensor("torch.float32"), 1, "interleaved"), (FakeTensor("torch.float32", 16), 0, "half")]:',
      '    try: rotary(tensor, layout, mode)',
      '    except unsupported as exc: assert "configurations" in str(exc)',
      '    else: raise AssertionError("expected UnsupportedConfiguration")',
      'assert len(with_calls) == 2',
    ].join('\n'))
    const run = spawnSync(python!, [harness, join(sourceDir, 'cann_bench', '__init__.py')], { encoding: 'utf8' })
    expect(run.status, run.stderr).toBe(0)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('support rows may only reference attributes the guard can observe', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'canness-support-attrs-'))
  try {
    const generation = 'gen-13572468'
    const wrapper = 'def rotary(input, layout=0, rotaryMode="half"):\n    raise NotImplementedError\n'
    const signature = 'rotary(input, layout=0, rotaryMode="half")'
    const make = (support: unknown) => {
      const spec = parseSpec({ ...base, support })
      writeOperator(workspace, generation, {
        kernel: 'extern "C" __global__ __aicore__ void canness_kernel(GM_ADDR x, GM_ADDR out, GM_ADDR tiling) {}',
        host: '', api: '', plugin: '',
      })
      buildTestPackage(workspace, generation, spec)
      return spec
    }
    // `mode` is a compiled attribute the wrapper never exposes: a row keyed on
    // `mode` can never match, so refuse the export instead of shipping a guard
    // that silently stops constraining it.
    const unobservable = make({ wrapper_attrs: ['rotaryMode'], configurations: [{ attrs: { mode: 'half' } }] })
    expect(() => exportSubmission(workspace, generation, unobservable, 'rotary', { wrapper, signature }))
      .toThrow(/cannot observe.*mode|cannot observe/)
    // Signature parameters and fixed compiled attributes are both reachable, so
    // an interface.attrs list that keeps `mode` (compiled) is fine.
    const mixed = parseSpec({
      ...base, attrs: { layout: 0, mode: 'half' }, interface: { attrs: ['layout'], dtypes: ['fp32', 'bf16'] },
      support: { wrapper_attrs: ['rotaryMode'], configurations: [{ attrs: { layout: 0, rotaryMode: 'half', mode: 'half' } }] },
    })
    buildTestPackage(workspace, generation, mixed)
    const { sourceDir } = exportSubmission(workspace, generation, mixed, 'rotary', { wrapper, signature })
    expect(readFileSync(join(sourceDir, 'cann_bench', '__init__.py'), 'utf8')).toContain('rotaryMode')
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

