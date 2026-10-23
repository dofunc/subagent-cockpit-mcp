import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const eslint = new ESLint({ cwd: ROOT })

async function restrictedImports(filePath: string, code: string): Promise<number> {
  const [result] = await eslint.lintText(code, { filePath: join(ROOT, filePath) })
  return result.messages.filter(m => m.ruleId === 'no-restricted-imports').length
}

const NODE_IMPORT = 'import { readFile } from \'node:fs\'\nexport const read = readFile\n'

describe('layer boundaries', () => {
  for (const path of ['src/adapter/probe.ts', 'src/session/probe.ts', 'src/config.ts', 'src/host/host.ts']) {
    test(`U50 ${path} must not import Node modules`, async () => {
      assert.ok(await restrictedImports(path, NODE_IMPORT) > 0)
    })
  }

  test('U50 bare builtin names and the MCP SDK are rejected too', async () => {
    assert.ok(await restrictedImports('src/session/probe.ts', 'import { join } from \'path\'\nexport const j = join\n') > 0)
    assert.ok(await restrictedImports('src/adapter/probe.ts', 'import { Server } from \'@modelcontextprotocol/sdk/server/index.js\'\nexport const s = Server\n') > 0)
  })

  test('U51 the MCP layer may import Node modules', async () => {
    assert.equal(await restrictedImports('src/host/node-host.ts', NODE_IMPORT), 0)
  })

  test('U95 the adapter layer must not import the session layer', async () => {
    assert.ok(await restrictedImports('src/adapter/probe.ts', 'import { SessionManager } from \'../session/session-manager\'\nexport const m = SessionManager\n') > 0)
  })
})

describe('webui boundaries', () => {
  const importOf = (from: string) => `import * as m from '${from}'\nexport const x = m\n`
  const FORBIDDEN: Record<string, string[]> = {
    'src/webui/app/App.tsx': ['node:fs', '../../session/session-manager', '../../config', '../../server', '../link', '../server'],
    'src/webui/app/widgets/Transcript.tsx': ['../../../session/session-manager', '../../../server', '../../link', '../../server'],
    'src/webui/transcript.ts': ['node:fs', '../adapter/adapter', './link'],
    'src/webui/server.ts': ['../session/session-manager', '../config', '../server', './link'],
    'src/session/session-manager.ts': ['../webui/link'],
  }
  const ALLOWED: Record<string, string[]> = {
    'src/webui/app/App.tsx': ['../../types', '../transcript', '../protocol', './widgets/Transcript'],
    'src/webui/app/widgets/Transcript.tsx': ['../../../types', '../../transcript', './ToolCallCard', 'antd', '@ant-design/x'],
    'src/webui/server.ts': ['ws', 'node:http', './transcript', '../types'],
  }

  for (const [path, imports] of Object.entries(FORBIDDEN)) {
    for (const from of imports) {
      test(`U218 ${path} must not import ${from}`, async () => {
        assert.ok(await restrictedImports(path, importOf(from)) > 0)
      })
    }
  }

  for (const [path, imports] of Object.entries(ALLOWED)) {
    test(`U218 ${path} may import ${imports.join(', ')}`, async () => {
      const counts = await Promise.all(imports.map(from => restrictedImports(path, importOf(from))))
      assert.deepEqual(counts, imports.map(() => 0))
    })
  }
})

describe('conversation store and truncation', () => {
  const importOf = (from: string) => `import * as m from '${from}'\nexport const x = m\n`
  const ALLOWED: Record<string, string[]> = {
    'src/conversation-store.ts': ['./webui/transcript', './webui/truncate', 'node:buffer'],
    'src/webui/link.ts': ['./truncate'],
  }
  const FORBIDDEN: Record<string, string[]> = {
    'src/session/session-manager.ts': ['../conversation-store'],
    'src/webui/transcript.ts': ['./truncate', '../conversation-store'],
    'src/webui/app/App.tsx': ['../truncate', '../../conversation-store'],
    'src/webui/server.ts': ['../conversation-store'],
  }

  for (const [path, imports] of Object.entries(ALLOWED)) {
    test(`U258 ${path} may import ${imports.join(', ')}`, async () => {
      const counts = await Promise.all(imports.map(from => restrictedImports(path, importOf(from))))
      assert.deepEqual(counts, imports.map(() => 0))
    })
  }

  for (const [path, imports] of Object.entries(FORBIDDEN)) {
    for (const from of imports) {
      test(`U258 ${path} must not import ${from}`, async () => {
        assert.ok(await restrictedImports(path, importOf(from)) > 0)
      })
    }
  }
})
