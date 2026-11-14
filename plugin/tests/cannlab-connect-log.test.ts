import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { loggedTunnel } from '../src/cannlab/connect-log.ts'

test('recognizes a forwarded endpoint from a previous process by its host, port and key', () => {
  const log = join(mkdtempSync(join(tmpdir(), 'canness-connect-log-')), 'last-connect.log')
  const key = 'C:/test path/id_001'
  writeFileSync(log, [
    '# CANNLab connect attempt 2026-11-14T12:53:56.267Z',
    '2026-11-14T12:54:09.847Z info  selecting Using environment "Exp". :: id instance-1 · devstage stage-1',
    '2026-11-14T12:54:12.124Z info  helper-ready Forwarding helper is up. :: 127.0.0.1:49688 (pid 22672)',
    `2026-11-14T12:54:14.912Z done  done Connected to "Exp". :: developer@127.0.0.1:20022 via ${key}`,
  ].join('\n'))
  expect(loggedTunnel(log, '127.0.0.1', 20022, key)).toEqual({
    name: 'Exp', instanceId: 'instance-1', helperPort: 49688, connectedAt: '2026-11-14T12:54:14.912Z',
  })
  expect(loggedTunnel(log, '127.0.0.1', 22, key)).toBeNull()
  expect(loggedTunnel(log, '127.0.0.1', 20022, 'other-key')).toBeNull()
})
