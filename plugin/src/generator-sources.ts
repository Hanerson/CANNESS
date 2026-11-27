import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { LAYER_FILES, type LayerName } from './package-files.js'
import { parseProvenance, type Origin } from './provenance.js'
import type { OperatorSpec } from './spec.js'

// Target timing is a budget setting, not part of the source contract. Be
// conservative about every other spec field, including tensor shapes and attrs.
export function sameSourceContract(left: OperatorSpec, right: OperatorSpec): boolean {
  const normalize = (value: unknown): unknown => Array.isArray(value) ? value.map(normalize)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalize(item)])) : value
  const sourceContract = ({ performance_target: _timing, target_platform, ...rest }: OperatorSpec) => {
    const { confirmation: _confirmation, ...platform } = target_platform
    return { ...rest, target_platform: platform }
  }
  return JSON.stringify(normalize(sourceContract(left))) === JSON.stringify(normalize(sourceContract(right)))
}
export function carrySources(workspace: string, previous: string, next: string): boolean {
  const source = join(workspace, 'operators', previous)
  const target = join(workspace, 'operators', next)
  let carried = false
  for (const file of [...Object.values(LAYER_FILES), 'golden.h', 'layer-origins.json']) {
    if (!existsSync(join(source, file))) continue
    mkdirSync(dirname(join(target, file)), { recursive: true })
    copyFileSync(join(source, file), join(target, file))
    if (Object.values(LAYER_FILES).includes(file as typeof LAYER_FILES[LayerName])) carried = true
  }
  return carried
}
export function hasKernelSource(workspace: string, generationId: string): boolean {
  return existsSync(join(workspace, 'operators', generationId, LAYER_FILES.kernel))
}
export function writePartialOperator(workspace: string, generationId: string, files: Partial<Record<LayerName, string>>, origins: Partial<Record<LayerName, Origin>>): string {
  const root = join(workspace, 'operators', generationId)
  const metadata = join(root, 'layer-origins.json')
  const previous = existsSync(metadata) ? parseProvenance(JSON.parse(readFileSync(metadata, 'utf8'))) : {}
  for (const layer of Object.keys(LAYER_FILES) as LayerName[]) {
    if (files[layer] === undefined) continue
    const path = join(root, LAYER_FILES[layer])
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, files[layer])
    delete previous[layer]
    if (origins[layer]) previous[layer] = origins[layer]
  }
  writeFileSync(metadata, JSON.stringify(previous, null, 2))
  return root
}
