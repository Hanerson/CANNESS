import { expect, test } from 'vitest'
import { commandResultFromOutcome, outcomeFromCommand, parseProbeInput, PROBE_TIMEOUT_MS } from '../src/probe-contract.ts'
import { probeTcp, type TcpDial } from '../src/probe.ts'

test('parseProbeInput takes the host and a trailing port', () => {
  expect(parseProbeInput(' npu 2222')).toEqual({ host: 'npu', port: 2222 })
  expect(parseProbeInput('')).toEqual({ error: 'empty-host' })
  expect(parseProbeInput('npu')).toEqual({ error: 'empty-host' })
  expect(parseProbeInput('npu abc')).toEqual({ error: 'invalid-port' })
  expect(parseProbeInput('npu 0')).toEqual({ error: 'invalid-port' })
  expect(parseProbeInput('npu 70000')).toEqual({ error: 'invalid-port' })
})

test('probeTcp resolves when the dial connects', async () => {
  const seen: Array<{ host: string; port: number; timeoutMs: number }> = []
  const dial: TcpDial = async (host, port, timeoutMs) => { seen.push({ host, port, timeoutMs }) }
  await expect(probeTcp(' npu ', 22, dial)).resolves.toEqual({ ok: true })
  expect(seen).toEqual([{ host: 'npu', port: 22, timeoutMs: PROBE_TIMEOUT_MS }])
})

test('probeTcp reports an empty host, a bad port, and a refused dial without throwing', async () => {
  const dial: TcpDial = async () => { throw new Error('connect ECONNREFUSED') }
  await expect(probeTcp('  ', 22, dial)).resolves.toEqual({ ok: false, reason: 'empty-host' })
  await expect(probeTcp('npu', 0, dial)).resolves.toEqual({ ok: false, reason: 'invalid-port' })
  await expect(probeTcp('npu', 22, dial)).resolves.toEqual({
    ok: false, reason: 'unreachable', detail: 'connect ECONNREFUSED',
  })
})

test('command text round-trips a reachable and an unreachable result', () => {
  expect(outcomeFromCommand(commandResultFromOutcome({ ok: true }))).toEqual({ ok: true })
  const refused = commandResultFromOutcome({ ok: false, reason: 'unreachable', detail: 'timeout' })
  expect(outcomeFromCommand(refused)).toEqual({ ok: false, reason: 'unreachable', detail: 'timeout' })
  expect(outcomeFromCommand(undefined)).toEqual({ ok: false, reason: 'unavailable' })
})
