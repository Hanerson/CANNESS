import { spawnSync } from 'node:child_process'

/**
 * Validate a CANNBench wrapper source before an export writes it.
 *
 * The validator parses the wrapper as UTF-8 and checks that the public callable
 * exists exactly once with the declared signature. Running the same check at
 * export time turns a late `invalid wrapper or public signature syntax` into an
 * actionable export error (a wrapper with the wrong encoding used to be written
 * and only rejected during submission validation).
 */

export interface WrapperCheck {
  mode: 'python' | 'syntax-only'
  warnings: string[]
}

const PROBE = String.raw`
import ast, json, sys

request = json.loads(sys.stdin.buffer.read().decode("utf-8"))
source, signature, callable_name = request["source"], request["signature"], request["callable"]
try:
    module = ast.parse(source)
except SyntaxError as error:
    print(json.dumps({"ok": False, "error": f"wrapper does not parse: {error.msg} (line {error.lineno})"}))
    sys.exit(0)
functions = [node for node in module.body
             if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == callable_name]
if len(functions) != 1 or not isinstance(functions[0], ast.FunctionDef):
    print(json.dumps({"ok": False,
                      "error": f"wrapper must define {callable_name} exactly once at module level (found {len(functions)})"}))
    sys.exit(0)
try:
    expected = ast.parse("def " + signature + ":\n    pass\n").body[0]
except SyntaxError as error:
    print(json.dumps({"ok": False, "error": f"public signature does not parse: {error.msg}"}))
    sys.exit(0)
if ast.dump(expected.args, include_attributes=False) != ast.dump(functions[0].args, include_attributes=False):
    print(json.dumps({"ok": False, "error": "wrapper signature differs from the declared public signature"}))
    sys.exit(0)
print(json.dumps({"ok": True}))
`

function python(): string | undefined {
  for (const candidate of ['python3', 'python']) {
    if (spawnSync(candidate, ['--version'], { encoding: 'utf8' }).status === 0) return candidate
  }
  return undefined
}

export function checkWrapperSource(source: string, callable: string, signature: string): WrapperCheck {
  if (!source.trim()) throw new Error('wrapper source is empty')
  if (source.includes('\u0000')) throw new Error('wrapper source contains a NUL byte')
  const decoder = new TextDecoder('utf-8', { fatal: true })
  try {
    decoder.decode(Buffer.from(source, 'utf8'))
  } catch {
    throw new Error('wrapper source is not valid UTF-8')
  }
  const executable = python()
  if (executable === undefined) {
    // Without an interpreter only the cheapest structural check is possible.
    if (!new RegExp(`^def ${callable}\\(`, 'm').test(source)) {
      throw new Error(`wrapper does not define ${callable} at module level`)
    }
    return { mode: 'syntax-only', warnings: ['python is unavailable, so the wrapper was only checked structurally'] }
  }
  const result = spawnSync(executable, ['-c', PROBE], {
    input: JSON.stringify({ source, signature, callable }),
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    // The wrapper may carry non-ASCII text; without this Windows reads stdin
    // with the ANSI code page and hands ast.parse lone surrogates.
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  })
  if (result.status !== 0) {
    throw new Error(`wrapper check failed to run: ${result.stderr.trim() || result.error?.message || result.status}`)
  }
  const parsed = JSON.parse(result.stdout.trim() || '{"ok":false,"error":"empty probe output"}') as
    { ok?: boolean; error?: string }
  if (parsed.ok !== true) throw new Error(parsed.error ?? 'wrapper does not satisfy the public signature')
  return { mode: 'python', warnings: [] }
}
