// The e2e layer's webui page: each group starts its server with a webui on a free port and keeps one
// browser page on it from beforeAll to afterAll. Playwright only; the node:test suites never import this.
import { expect } from '@playwright/test'
import type { Browser, Locator, Page } from '@playwright/test'
import { killWebuis, snapshot, webuiUp } from './browser'
import { freePort, startServer } from './e2e'
import type { Server } from './e2e'
import { until } from './harness'

export interface Watched {
  server: Server
  page: Page
  port: number
  /** Close the page and the server; the webui is ended at once instead of after its grace period */
  close(): Promise<void>
}

/** dist/cli.js on the home with its own webui, and a page that shows it. */
export async function startWatched(browser: Browser, home: string): Promise<Watched> {
  const port = await freePort()
  const server = await startServer(home, port)
  await webuiUp(port)
  // Activity before the server's connection is open never reaches the webui
  await until(async () => (await snapshot(port)).mcps.some(m => m.connected), 10_000, 'MCP server connected to the webui')
  const page = await browser.newPage()
  await page.goto(`http://127.0.0.1:${port}`)
  return {
    server,
    page,
    port,
    async close() {
      await page.close()
      await server.close()
      killWebuis(port)
    },
  }
}

/** The sessions of one subagent in the list, newest last. */
export const sessionsOf = (page: Page, subagent: string): Locator =>
  page.getByRole('menuitem', { name: subagent, exact: true }).locator('xpath=following-sibling::*[@role="menu"][1]').getByRole('menuitem')

/** Select the newest session of a subagent and return its conversation. */
export async function showLatest(page: Page, subagent: string): Promise<Locator> {
  await sessionsOf(page, subagent).last().click()
  await page.getByRole('tab', { name: 'Conversation' }).click()
  return page.getByRole('tabpanel', { name: 'Conversation' })
}

/** A finished turn with the given outcome: done, cancelled or error. */
export const turnEnd = (conversation: Locator, outcome: string): Locator =>
  conversation.getByRole('separator').filter({ hasText: new RegExp(`^turn \\d+ · ${outcome}`) })

/** The approval cards of a conversation. */
export const approvals = (conversation: Locator): Locator => conversation.getByRole('alert').filter({ hasText: /^Permission: / })

/** The prompt was sent, a reply came back and the turn ended done. */
export async function expectAnsweredTurn(page: Page, subagent: string, prompt: string | RegExp, reply: string | RegExp): Promise<void> {
  const conversation = await showLatest(page, subagent)
  await expect(conversation.getByText(prompt).first()).toBeVisible()
  await expect(conversation.getByText(reply).last()).toBeVisible()
  await expect(turnEnd(conversation, 'done').last()).toBeVisible()
}
