import { cpSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { OperatorSpec } from './spec.ts'

export const LAYER_FILES = {
  kernel: 'op_kernel/kernel.cpp',
  host: 'op_host/host.cpp',
  api: 'op_api/api.cpp',
  plugin: 'op_plugin/plugin.py',
} as const

export type LayerName = keyof typeof LAYER_FILES

function writeRel(root: string, rel: string, body: string): void {
  const full = join(root, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, body)
}

export function writeOperator(workspace: string, generationId: string, files: Record<LayerName, string>): string {
  const root = join(workspace, 'operators', generationId)
  for (const key of Object.keys(LAYER_FILES) as LayerName[]) writeRel(root, LAYER_FILES[key], files[key])
  return root
}

export function buildTestPackage(workspace: string, generationId: string, spec: OperatorSpec): string {
  const src = join(workspace, 'operators', generationId)
  const dest = join(workspace, 'packages', generationId)
  mkdirSync(dest, { recursive: true })
  cpSync(src, dest, { recursive: true })
  writeFileSync(join(dest, 'manifest.json'), JSON.stringify({
    generationId,
    operatorName: spec.operator_name,
    performanceTargetUs: spec.performance_target.target_us,
    files: Object.values(LAYER_FILES),
  }, null, 2))
  return dest
}
