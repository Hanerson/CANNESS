import { expect, test } from 'vitest'
import { parseAnalysis } from '../src/analysis.ts'

test('source-tagged launch and kernel metadata survive report parsing without replacing CSV task type', () => {
  const report = parseAnalysis({ source: 'msprof', bottleneck: 'unknown', summary: 'measured', op: {
    taskDurationUs: 12, taskType: 'AI_CORE', blockDim: 40, blockDimSource: 'launch-config',
    kernelTaskType: 'AIV', kernelTaskTypeSource: 'op_kernel/kernel.cpp:KERNEL_TASK_TYPE_DEFAULT(KERNEL_TYPE_AIV_ONLY)',
  } })
  expect(report?.op).toMatchObject({ taskType: 'AI_CORE', blockDim: 40, blockDimSource: 'launch-config', kernelTaskType: 'AIV' })
  expect(report?.op?.kernelTaskTypeSource).toContain('op_kernel/kernel.cpp')
})
test('unknown subtype and origin remain null instead of becoming guessed hardware facts', () => {
  const report = parseAnalysis({ source: 'msprof', bottleneck: 'unknown', summary: '', op: {
    taskDurationUs: 1, taskType: 'AI_CORE', kernelTaskType: 'GPU', blockDimSource: 'guessed',
  } })
  expect(report?.op).toMatchObject({ taskType: 'AI_CORE', blockDimSource: null, kernelTaskType: null })
})
