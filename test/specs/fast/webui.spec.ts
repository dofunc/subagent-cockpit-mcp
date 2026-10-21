import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { killWebuis, webuiUp } from '../../fixtures/browser'
import { freePort, startServer } from '../../fixtures/e2e'
import type { Server } from '../../fixtures/e2e'
import { setup } from '../../fixtures/harness'
import type { Harness, HarnessOptions } from '../../fixtures/harness'
import type { Step } from '../../fixtures/scripted-acp-agent'

// dist/cli.js with the real grok adapter over the scripted agent; MCP tools drive it, the page shows it live

interface Cockpit {
  h: Harness
  port: number
  server: Server
  call(name: string, args?: Record<string, unknown>): Promise<Record<string, unknown>>
  open(role?: string): Promise<string>
}

/** One MCP server on its own home and webui port, with the page open on that webui. */
async function withCockpit(page: Page, scripts: HarnessOptions['scripts'], fn: (c: Cockpit) => Promise<void>): Promise<void> {
  const h = await setup({ adapter: 'grok', scripts })
  const port = await freePort()
  const server = await startServer(h.home, port)
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const reply = await server.call(name, args)
    expect(reply.isError, JSON.stringify(reply.data)).toBe(false)
    return reply.data
  }
  try {
    await webuiUp(port)
    await page.goto(`http://127.0.0.1:${port}`)
    await fn({
      h,
      port,
      server,
      call,
      open: async role => String((await call('open', { subagent: 'agent', cwd: h.dir, ...(role ? { role } : {}) })).session),
    })
  } finally {
    await server.close()
    killWebuis(port)
    await h.cleanup()
  }
}

const conversation = (page: Page) => page.getByRole('tabpanel', { name: 'Conversation' })
const sessionItem = (page: Page, state: string) => page.getByRole('menuitem', { name: new RegExp(` ${state}$`) })
const field = (page: Page, label: string) => page.locator('th').filter({ hasText: new RegExp(`^${label}$`) }).locator('xpath=following-sibling::td[1]')
const thought = (text: string): Step => ({ update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } } })

test.describe('fast: webui with MCP tools', () => {
  test('F1 an opened session appears with its agent, config and role prompt', async ({ page }) => {
    await withCockpit(page, { agent: {} }, async ({ open }) => {
      const session = await open('You review code.')
      await expect(page.getByRole('menuitem', { name: 'agent', exact: true })).toBeVisible()
      await expect(page.getByRole('menuitem', { name: `${session} IDLE` })).toBeVisible()
      await expect(conversation(page).getByText('role prompt')).toBeVisible()
      await expect(conversation(page).getByText(/You review code\./)).toBeVisible()
      await page.getByRole('tab', { name: 'Session' }).click()
      await expect(field(page, 'Adapter')).toHaveText('grok')
      await expect(field(page, 'Session')).toContainText(session)
      await expect(field(page, 'Config')).toContainText(/mode: auto.*model: gpt-a.*reasoning_effort: medium/)
    })
  })

  test('F2 a turn streams into one reply, then ends done', async ({ page }) => {
    await withCockpit(page, {
      agent: { turns: [[thought('Planning the answer.'), { sleep: 300 }, { chunk: 'Hello ', messageId: 'm1' }, { sleep: 1200 }, { chunk: 'world', messageId: 'm1' }, { sleep: 600 }]] },
    }, async ({ open, call }) => {
      const session = await open()
      const pending = call('prompt', { session, text: 'greet me' })
      await expect(sessionItem(page, 'RUNNING')).toBeVisible()
      await expect(conversation(page).getByText('Hello', { exact: true })).toBeVisible()
      await expect(conversation(page).getByText('Hello world', { exact: true })).toBeVisible()
      await expect(conversation(page).getByText('Thinking')).toBeVisible()
      await expect(conversation(page).getByText('Planning the answer.')).toBeVisible()
      expect((await pending).status).toBe('done')
      await expect(conversation(page).getByRole('separator').filter({ hasText: /^turn \d+ · done/ })).toBeVisible()
      await expect(sessionItem(page, 'IDLE')).toBeVisible()
    })
  })

  test('F3 a tool call waits on an approval; approve and reject are labelled', async ({ page }) => {
    await withCockpit(page, {
      agent: {
        turns: [[
          { update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Edit a.ts', kind: 'edit', status: 'pending', content: [{ type: 'diff', path: '/w/a.ts', oldText: 'a\n', newText: 'b\n' }] } },
          { permission: { title: 'Edit a.ts' } },
          { update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' } },
          { permission: { title: 'Run rm' } },
          { chunk: 'end' },
        ]],
      },
    }, async ({ open, call }) => {
      const session = await open()
      const first = await call('prompt', { session, text: 'edit it' })
      expect(first.status).toBe('approval_needed')
      await expect(sessionItem(page, 'ASKING')).toBeVisible()
      const edit = conversation(page).getByRole('alert').filter({ hasText: 'Permission: Edit a.ts' })
      await expect(edit).toContainText('waiting for an answer')
      await expect(conversation(page).getByText('edit · /w/a.ts')).toBeVisible()

      const approvalId = (reply: Record<string, unknown>) => {
        const approval = reply.approval
        return approval && typeof approval === 'object' && 'approval_id' in approval ? approval.approval_id : null
      }
      const second = await call('approve', { session, approval_id: approvalId(first) })
      await expect(edit).toContainText('approved once')
      await expect(conversation(page).getByRole('button', { name: /^check-circle Edit a\.ts/ })).toBeVisible()
      await call('reject', { session, approval_id: approvalId(second) })
      await expect(conversation(page).getByRole('alert').filter({ hasText: 'Permission: Run rm' })).toContainText('rejected')
    })
  })

  test('F4 a question waits for an answer; the answer is shown', async ({ page }) => {
    await withCockpit(page, { agent: { turns: [[{ question: { message: 'Pick a color' } }, { chunk: 'after' }]] } }, async ({ open, call }) => {
      const session = await open()
      const asked = await call('prompt', { session, text: 'ask me' })
      expect(asked.status).toBe('question_needed')
      await expect(sessionItem(page, 'QUESTIONING')).toBeVisible()
      const question = asked.question
      const questionId = question && typeof question === 'object' && 'question_id' in question ? question.question_id : null
      await call('answer', { session, question_id: questionId, action: 'accept', content: { q0: 'red' } })
      const card = conversation(page).getByRole('alert').filter({ hasText: 'Question: Pick a color' })
      await expect(card).toContainText('accept')
      // One `field → answer` line per field, not JSON; a oneOf answer shows its choice's title
      await expect(card).toContainText('q0→Red')
    })
  })

  test('F5 a cancelled turn and a failed turn end with their own divider', async ({ page }) => {
    await withCockpit(page, { agent: { turns: [[{ sleep: 5000 }], [{ error: 'boom' }]] } }, async ({ open, call, server }) => {
      const session = await open()
      await call('prompt', { session, text: 'slow', wait: false })
      await expect(sessionItem(page, 'RUNNING')).toBeVisible()
      await call('cancel', { session })
      await expect(conversation(page).getByRole('separator').filter({ hasText: /^turn \d+ · cancelled/ })).toBeVisible()
      const failed = await server.call('prompt', { session, text: 'fail' })
      expect(JSON.stringify(failed.data)).toMatch(/boom/)
      await expect(conversation(page).getByRole('alert').filter({ hasText: /^session\/prompt failed: boom/ })).toBeVisible()
      await expect(conversation(page).getByRole('separator').filter({ hasText: /^turn \d+ · error/ })).toBeVisible()
    })
  })

  test('F6 a closed session and a second MCP server that is killed', async ({ page }) => {
    await withCockpit(page, { agent: {} }, async ({ h, port, open, call }) => {
      const first = await open()
      await call('close', { session: first })
      await expect(page.getByRole('menuitem', { name: `${first} CLOSED` })).toBeVisible()

      const other = await startServer(h.home, port)
      try {
        const opened = await other.call('open', { subagent: 'agent', cwd: h.dir })
        const second = String(opened.data.session)
        await expect(page.getByRole('menuitem', { name: `${second} IDLE` })).toBeVisible()
        process.kill(other.pid ?? 0, 'SIGKILL')
        await expect(page.getByRole('menuitem', { name: `${second} disconnect IDLE` })).toBeVisible()
      } finally {
        await other.close()
      }
    })
  })

  test('F7 the protocol log lists the turn\'s messages; a row expands to the raw JSON', async ({ page }) => {
    await withCockpit(page, { agent: { turns: [[{ chunk: 'logged' }]] } }, async ({ open, call }) => {
      const session = await open()
      await call('prompt', { session, text: 'write the log' })
      await page.getByRole('tab', { name: 'Protocol log' }).click()
      const log = page.getByRole('tabpanel', { name: 'Protocol log' })
      for (const method of [/^initialize #\d+$/, /^session\/new #\d+$/, /^session\/prompt #\d+$/, /^session\/update$/]) {
        await expect(log.getByText(method).first()).toBeVisible()
      }
      await log.getByRole('row').filter({ hasText: /session\/prompt #\d+/ }).filter({ hasText: 'write the log' }).getByRole('button', { name: /expand row/i }).click()
      await expect(log.getByText(/"text": "write the log"/)).toBeVisible()
    })
  })
})
