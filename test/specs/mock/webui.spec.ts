import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { snapshot, startMock } from '../../fixtures/browser'
import type { Mock } from '../../fixtures/browser'

// The fake MCP servers of mock/webui.ts feed a real webui; every activity is out before a page opens
const context: { mock?: Mock } = {}

test.beforeAll(async () => {
  context.mock = await startMock()
})

test.afterAll(() => context.mock?.stop())

const mockUrl = () => context.mock?.url ?? ''

async function openPage(page: Page): Promise<void> {
  await page.goto(mockUrl())
  await expect(page.getByRole('menuitem', { name: 'Coder', exact: true })).toBeVisible()
}

/** Pick a session in the list by the start of its name. */
const pick = (page: Page, name: string) => page.getByRole('menuitem', { name: new RegExp(`^${name}`) }).click()

const tab = (page: Page, name: string) => page.getByRole('tabpanel', { name })

/** The value cell next to a label in the session info table. */
const field = (page: Page, label: string) => page.locator('th').filter({ hasText: new RegExp(`^${label}$`) }).locator('xpath=following-sibling::td[1]')

const alert = (scope: Locator, title: string) => scope.getByRole('alert').filter({ hasText: title })

/** Computed font-family and font-size of the first element a locator finds. */
const font = (locator: Locator) => locator.first().evaluate(el => [getComputedStyle(el).fontFamily, getComputedStyle(el).fontSize])

const MONO = /^"?Sarasa Mono SC"?,/

/** Where each text starts on screen, inside one element; texts on separate lines have different tops. */
const lineTops = (scope: Locator, texts: string[]) => scope.first().evaluate((root, wanted) => {
  const collect = (node: Node): Node[] => (node.nodeType === Node.TEXT_NODE ? [node] : Array.from(node.childNodes).flatMap(collect))
  const nodes = collect(root)
  return wanted.map(want => {
    const node = nodes.find(n => n.textContent?.includes(want))
    const start = node?.textContent?.indexOf(want) ?? -1
    if (!node || start < 0) return null
    const range = document.createRange()
    range.setStart(node, start)
    range.setEnd(node, start + 1)
    return range.getBoundingClientRect().top
  })
}, texts)

/** Vertical center of an element's box. */
const center = async (locator: Locator) => {
  const box = await locator.boundingBox()
  return box ? box.y + box.height / 2 : Number.NaN
}

test.describe('mock: webui page', () => {
  test('W1 the session list groups sessions by subagent with state, disconnect mark and tooltip', async ({ page }) => {
    await openPage(page)
    for (const group of ['Coder', 'Reviewer', 'Planner', 'Releaser', 'Inspector', 'Writer', 'Cleanup', 'Tester']) {
      await expect(page.getByRole('menuitem', { name: group, exact: true }).locator('img')).toHaveCount(1)
    }
    // The pi group carries pi's own mark, inlined as a base64 data URI
    const piSrc = await page.getByRole('menuitem', { name: 'Tester', exact: true }).locator('img').getAttribute('src') ?? ''
    expect(Buffer.from(piSrc.replace(/^data:image\/svg\+xml;base64,/, ''), 'base64').toString('utf-8')).toContain('#F09082')
    await expect(page.getByRole('menuitem', { name: /^Add input validation .* IDLE$/ })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Fix the navbar overflow CLOSED' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Fix lint warnings disconnect IDLE' }).getByRole('img', { name: 'disconnect' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Review the navbar fix CLOSED' }).getByRole('img', { name: 'disconnect' })).toHaveCount(0)

    await page.getByRole('menuitem', { name: 'Review the navbar fix CLOSED' }).getByText('Review the navbar fix').hover()
    const tooltip = page.getByRole('tooltip').filter({ hasText: 'pid 51877' })
    await expect(tooltip).toContainText('Review the navbar fix')
    await expect(tooltip).toContainText('/Users/dev/web · pid 51877')
    await expect(tooltip).toContainText('ended: agent exited')
  })

  test('W2 the session tab shows who the session is and the agent\'s latest state', async ({ page }) => {
    await openPage(page)
    await pick(page, 'Fix auth middleware issues')
    await page.getByRole('tab', { name: 'Session' }).click()
    const expected: Array<[string, string | RegExp]> = [
      ['State', 'ASKING'],
      ['Subagent', 'Reviewer'],
      ['Adapter', 'claude'],
      ['Agent', 'Claude Agent 0.93.0'],
      ['Session', 'claude_7c0f9a52-1d3e-4b8a-9f61-2e5d8c4b7a90'],
      ['cwd', '/Users/dev/repo'],
      ['MCP server', '/Users/dev/repo · pid 41203'],
      ['Title', 'Fix auth middleware issues'],
      ['Mode', 'Accept Edits'],
      ['Model', 'Opus'],
      ['Context', /61,022 \/ 200,000 · 0\.57 USD/],
      ['Config', /Mode: Accept Edits.*Model: Opus.*Extended thinking: true/],
    ]
    for (const [label, value] of expected) await expect(field(page, label)).toContainText(value)
    await expect(field(page, 'Context').getByRole('progressbar')).toBeVisible()
    const panel = tab(page, 'Session')
    for (const command of ['/review', '/compact', '/init', '/pr-comments']) await expect(panel.getByText(command, { exact: true })).toBeVisible()
    await expect(panel.getByRole('heading', { name: 'Agent capabilities' })).toBeVisible()
    await expect(panel).toContainText('"loadSession": true')
  })

  test('W3 the conversation: prompts on the right, markdown replies, thinking, three turn endings', async ({ page }) => {
    await openPage(page)
    await pick(page, 'Add input validation')
    const panel = tab(page, 'Conversation')
    await expect(panel.getByText('role prompt')).toBeVisible()
    // Replies carry a tag like prompts do; the bubbles stay left and right
    await expect(panel.getByText('reply', { exact: true }).first()).toBeVisible()
    const prompt = await panel.getByText('Also handle the PATCH route.').boundingBox()
    const reply = await panel.getByText('Looking at the PATCH handler now').boundingBox()
    expect(prompt && reply && prompt.x > reply.x + 200).toBe(true)

    await expect(panel.getByRole('heading', { name: 'Summary' }).first()).toBeVisible()
    await expect(panel.getByRole('listitem').filter({ hasText: 'POST /users' }).first()).toBeVisible()
    await expect(panel.getByRole('table').filter({ hasText: 'src/api/validate.ts' }).first()).toBeVisible()
    await expect(panel.getByText(/^export function validateUser/).first()).toBeVisible()

    const thought = panel.getByText(/^The route inserts the body as-is/)
    await expect(thought).toBeVisible()
    await panel.getByText('Thinking').first().click()
    await expect(thought).toBeHidden()

    // The role turn, the validation turn and the live summary end done; one turn each is cancelled and fails
    for (const [ending, count] of [[/^turn \d+ · done/, 3], [/^turn \d+ · cancelled/, 1], [/^turn \d+ · error · [\d.]+s · Internal error/, 1]] as const) {
      await expect(panel.getByRole('separator').filter({ hasText: ending })).toHaveCount(count)
    }
    // Token counts from a thousand on read as K with one decimal, after the turn's duration; the cache hit rate is of the whole prompt
    await expect(panel.getByRole('separator').filter({ hasText: /^turn \d+ · done · end_turn · [\d.]+s · \d+(\.\d)?K tokens · cache 80%$/ }).first()).toBeVisible()
  })

  test('W4 tool calls: status icons, diffs, terminal, locations, input and output as key/value lists', async ({ page }) => {
    await openPage(page)
    await pick(page, 'Add input validation')
    const panel = tab(page, 'Conversation')
    for (const header of [/^check-circle Read src\/api\/users\.ts/, /^close-circle npm test/, /^check-circle Edit src\/api\/validate\.ts/]) {
      await expect(panel.getByRole('button', { name: header }).first()).toBeVisible()
    }
    await expect(panel.getByText('edit · /Users/dev/repo/src/api/users.ts')).toBeVisible()
    await expect(panel.getByText('new file · /Users/dev/repo/src/api/validate.ts')).toBeVisible()
    await expect(panel.getByText('@@ -0,0 +1,5 @@')).toBeVisible()
    await expect(panel.getByText('/Users/dev/repo/test/users.test.ts:12')).toBeVisible()

    // Added lines sit on a full-width background, not only colored text (each line starts with its hidden number)
    const added = panel.locator('pre code > span').filter({ hasText: /^\d+\+\s*if \(\(input\.name/ }).first()
    expect(await added.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)')

    // rawInput starts folded and lists its fields; a command array reads as typed
    const failed = panel.locator('.ant-collapse-item').filter({ has: page.getByRole('button', { name: /^close-circle npm test/ }) })
    await expect(failed.getByText('command', { exact: true })).toBeHidden()
    await failed.getByRole('button', { name: 'Input' }).click()
    await expect(failed.getByText('command', { exact: true })).toBeVisible()
    await expect(failed.locator('.ant-descriptions').getByText('npm test', { exact: true }).first()).toBeVisible()
    // rawOutput only shows when there is no content
    await expect(failed.getByText('exit_code')).toHaveCount(0)
    const search = panel.locator('.ant-collapse-item').filter({ has: page.getByRole('button', { name: /^check-circle Search createUser/ }) })
    await expect(search.getByText('matches', { exact: true })).toBeVisible()

    // Long output shows three lines, then expands in place
    expect(await failed.locator('p', { hasText: 'FAIL test/users.test.ts' }).innerText()).toMatch(/FAIL test\/users\.test\.ts\n.*rejects a name over 80 characters/)
    await expect(failed.getByText('Tests: 1 failed')).toHaveCount(0)
    await failed.getByText('+5 lines').click()
    await expect(failed.getByText(/Tests: 1 failed/)).toBeVisible()
    await failed.getByText('Show less').click()
    await expect(failed.getByText(/Tests: 1 failed/)).toHaveCount(0)

    // No JSON on the conversation tab
    await expect(panel.getByText(/"(duration_ms|command|path)":/)).toHaveCount(0)

    // Rare shapes live in the Inspector session
    await pick(page, 'Describe the attached screenshot')
    const rare = tab(page, 'Conversation')
    for (const header of [/^loading npm run dev/, /^minus-circle Note the follow-up .*no status/]) {
      await expect(rare.getByRole('button', { name: header })).toBeVisible()
    }
    await expect(rare.getByText('terminal term-7')).toBeVisible()
    await expect(rare.getByRole('button', { name: /^check-circle Fetch https:\/\/json-schema\.org/ })).toContainText('no tool_call start')
  })

  test('W5 plans, notices, compaction, subagents and session messages', async ({ page }) => {
    await openPage(page)
    await pick(page, 'Plan the migration')
    const panel = tab(page, 'Conversation')
    for (const plan of ['Plan', 'Plan migration', 'Plan rollout', 'Plan spec']) await expect(panel.getByText(plan, { exact: true })).toHaveCount(1)
    await expect(panel.getByRole('heading', { name: 'Rollout' })).toBeVisible()
    await expect(panel.getByText('file:///Users/dev/repo/docs/billing-migration.md')).toBeVisible()
    await expect(panel.getByText('removed', { exact: true })).toHaveCount(1)
    // Notices, compaction and subagent updates are one-line events without a frame
    for (const notice of ['Using cached repository index', 'Rate limited', 'Sandbox unavailable', 'Compaction c-1 · completed']) {
      await expect(panel.getByText(notice).first()).toBeVisible()
      await expect(alert(panel, notice)).toHaveCount(0)
    }
    await expect(panel.getByText(/^Rate limited · Retrying in 5 seconds\.$/)).toBeVisible()
    await expect(panel.getByText('compaction summary')).toBeVisible()
    await expect(panel.getByText(/^Subagent Explore billing SDK · /)).toHaveCount(2)
    await expect(panel.getByText(/^Subagent Explore billing SDK · running · Reads the vendor SDK and lists breaking changes$/)).toBeVisible()
    await expect(panel.getByText(/^session message sub-7f3a → /)).toHaveCount(2)
  })

  test('W6 every approval and question outcome is labelled', async ({ page }) => {
    await openPage(page)
    await pick(page, 'Fix auth middleware issues')
    const reviewer = tab(page, 'Conversation')
    await expect(alert(reviewer, 'Permission: Edit src/middleware/auth.ts')).toContainText('approved once')
    await expect(alert(reviewer, 'allowed for this session')).toHaveCount(1)
    await expect(alert(reviewer, 'Permission: rm -rf dist')).toContainText('rejected')
    await expect(alert(reviewer, 'Permission: npm run test:coverage')).toContainText('cancelled')
    await expect(alert(reviewer, 'auto-approved by session rule')).toHaveCount(1)
    await expect(alert(reviewer, 'Permission: git commit')).toContainText('waiting for an answer')
    // The description sits on the title line; a command equal to the title is not repeated in a code box
    const rm = alert(reviewer, 'Permission: rm -rf dist')
    await expect(rm).toContainText('Permission: rm -rf dist · Clean the build output')
    await expect(rm.locator('pre')).toHaveCount(0)
    // A request without a command or description lists its rawInput fields
    const edit = alert(reviewer, 'Permission: Edit src/middleware/auth.ts')
    await expect(edit.getByText('file_path', { exact: true })).toBeVisible()
    await expect(edit.getByText('/Users/dev/repo/src/middleware/auth.ts', { exact: true })).toBeVisible()

    await pick(page, 'Set up the release workflow')
    const asker = tab(page, 'Conversation')
    const registry = alert(asker, 'Question: Which registry should the release publish to?')
    await expect(registry).toContainText('accept')
    // An accepted form reads as one `field → answer` line per field
    await expect(registry).toContainText('registry→npm')
    await expect(registry).toContainText('dist-tag→next')
    // A form still waiting lists its fields: title, required mark, choices by title, description
    const bump = alert(asker, 'Question: Which version bump?')
    for (const part of ['Version bump', '*', 'Patch (1.4.3)', 'Minor (1.5.0)', 'Major (2.0.0)', 'Follows semver from 1.4.2', 'Dry run', 'boolean']) {
      await expect(bump.getByText(part, { exact: true })).toBeVisible()
    }
    await expect(alert(asker, 'Question: Also create a GitHub release?')).toContainText('decline')
    await expect(alert(asker, 'Question: Pick the changelog format')).toContainText('cancel')
    await expect(alert(asker, 'Question: Allow anonymous usage statistics?')).toContainText('skipped outside a turn')
    await expect(alert(asker, 'Question: Which version bump?')).toContainText('waiting for an answer')
  })

  test('W7 errors, truncation, raw entries, content blocks and the protocol log', async ({ page }) => {
    await openPage(page)
    await pick(page, 'Describe the attached screenshot')
    const panel = tab(page, 'Conversation')
    const invalid = alert(panel, 'session/set_config_option failed: Invalid params')
    await expect(invalid).toBeVisible()
    // error.data is a key/value list
    await expect(invalid.getByText('configId', { exact: true })).toBeVisible()
    await expect(invalid.getByText('grok-4.3 grok-code-fast', { exact: true }).first()).toBeVisible()
    await expect(alert(panel, 'fs/read_text_file failed: Method not found')).toBeVisible()
    await expect(panel.getByText(/^Message truncated: 3,456,789 bytes · /)).toBeVisible()
    await expect(alert(panel, 'Message truncated')).toHaveCount(0)
    await expect(panel.getByText('usage_breakdown', { exact: true })).toBeVisible()
    await expect(panel.getByText('_x.ai/session/telemetry', { exact: true })).toBeVisible()
    // Raw items list their params; the session id already is the session
    await expect(panel.getByText('tokensPerSecond', { exact: true })).toBeVisible()
    await expect(panel.getByText('182.4', { exact: true })).toBeVisible()
    await expect(panel.locator('img[src^="data:image/svg+xml"]')).toHaveCount(1)
    await expect(panel.locator('audio')).toHaveCount(1)
    await expect(panel.getByText('Migration spec')).toBeVisible()
    await expect(panel.getByText(/^export const config/)).toBeVisible()
    await expect(panel.getByText('blob, 16 base64 chars')).toBeVisible()

    // The JSON-RPC messages are on the protocol log tab only
    await expect(panel.getByRole('button', { name: /raw messages/i })).toHaveCount(0)
    await expect(panel.getByText(/"jsonrpc": "2.0"/)).toHaveCount(0)

    await page.getByRole('tab', { name: 'Protocol log' }).click()
    const log = tab(page, 'Protocol log')
    const held = (await snapshot(context.mock?.port ?? 0)).sessions.find(s => s.session === 'grok_grok-01k2x9v7m4')
    const arrows = log.getByRole('img', { name: /^arrow-(left|right)$/ })
    await expect(arrows).toHaveCount(held?.log.length ?? -1)
    // Newest first: the first row has the highest number, the last the lowest
    const numbers = held?.log.map(entry => entry.seq) ?? []
    const rows = log.locator('tr.ant-table-row')
    await expect(rows.first().locator('td').nth(1)).toHaveText(String(Math.max(...numbers)))
    await expect(rows.last().locator('td').nth(1)).toHaveText(String(Math.min(...numbers)))
    const color = (name: string) => log.getByRole('img', { name }).first().evaluate(el => getComputedStyle(el).color)
    expect(await color('arrow-right')).not.toBe(await color('arrow-left'))
    await log.getByRole('button', { name: /expand row/i }).first().click()
    await expect(log.getByText(/"jsonrpc": "2.0"/).first()).toBeVisible()
  })

  test('W8 language and theme switch the page and survive a reload', async ({ page }) => {
    await openPage(page)
    const choose = async (language: string) => {
      await page.getByRole('banner').getByRole('button').first().hover()
      await page.getByRole('menuitem', { name: language }).click()
    }
    const labels: Array<[string, string, string]> = [['简体中文', '对话', '空闲'], ['繁體中文', '對話', '閒置'], ['日本語', '会話', '待機中'], ['English', 'Conversation', 'IDLE']]
    for (const [language, conversation, idle] of labels) {
      await choose(language)
      await expect(page.getByRole('tab', { name: conversation })).toBeVisible()
      await expect(page.getByRole('menuitem', { name: new RegExp(`^Add input validation .* ${idle}$`) })).toBeVisible()
      await page.reload()
      await expect(page.getByRole('tab', { name: conversation })).toBeVisible()
    }

    const background = () => page.getByRole('banner').evaluate(el => getComputedStyle(el).backgroundColor)
    const light = await background()
    // The radio inputs of the segmented control are hidden; its icons take the click
    await page.getByRole('banner').getByRole('img', { name: 'moon' }).click()
    await expect.poll(background).not.toBe(light)
    const dark = await background()
    await page.reload()
    await expect.poll(background).toBe(dark)
    await page.getByRole('banner').getByRole('img', { name: 'sun' }).click()
    await expect.poll(background).toBe(light)
  })

  test('W9 platform structures: grok events, codex auth and terminal output, claude tool names, opencode child sessions', async ({ page }) => {
    await openPage(page)
    await pick(page, 'Describe the attached screenshot')
    const inspector = tab(page, 'Conversation')
    await expect(inspector.getByText(/^Hook session_start · plugin\/team-rules:session_start success 95 ms$/)).toBeVisible()
    await expect(inspector.getByText(/^Turn summary · Screenshot matches the spec except the currency column$/)).toBeVisible()
    await expect(inspector.getByText(/^Session summary · Screenshot review against the billing spec$/)).toBeVisible()
    const hidden = ['_x.ai/session_notification', '_x.ai/session/setup', '_x.ai/queue/changed', '_x.ai/sessions/changed', '_x.ai/session/prompt_complete', 'turn_completed', 'response_completed', 'tool_call_delta_chunk']
    for (const name of hidden) await expect(inspector.getByText(name)).toHaveCount(0)
    await page.getByRole('tab', { name: 'Protocol log' }).click()
    const log = tab(page, 'Protocol log')
    for (const name of ['_x.ai/session_notification', '_x.ai/queue/changed', '_x.ai/session/prompt_complete']) await expect(log.getByText(name, { exact: true }).first()).toBeVisible()

    await pick(page, 'Add input validation')
    await page.getByRole('tab', { name: 'Session' }).click()
    await expect(field(page, 'Auth')).toHaveText('Custom model gateway · OpenAI')
    await expect(field(page, 'Thread')).toHaveText('active')
    await page.getByRole('tab', { name: 'Conversation' }).click()
    const coder = tab(page, 'Conversation')
    // codex sends this command's output only as _meta.terminal_output_delta
    const git = coder.locator('.ant-collapse-item').filter({ hasText: 'git status --short' }).first()
    await expect(git).toContainText('M src/api/users.ts')
    await expect(git).toContainText('?? src/api/validate.ts')
    // codex's _meta.quota: 9984 of 8556 + 9984 prompt tokens read from the cache
    await expect(coder.getByText(/18\.5K tokens · cache 54%$/)).toBeVisible()

    await pick(page, 'Fix auth middleware issues')
    const reviewer = tab(page, 'Conversation')
    const toolTag = (name: string) => reviewer.locator('.ant-collapse-header .ant-tag').filter({ hasText: new RegExp(`^${name}$`) })
    await expect(toolTag('Read')).toHaveCount(1)
    await expect(toolTag('Edit')).not.toHaveCount(0)
    await expect(reviewer.getByText(/^Set mode = acceptEdits$/)).toBeVisible()
    // List markers follow the compact text size, not the 16px the markdown theme fixes
    const item = reviewer.locator('.x-markdown ol > li').first()
    expect(await item.evaluate(li => [getComputedStyle(li, '::marker').fontSize, getComputedStyle(li).fontSize])).toEqual(['12px', '12px'])
    // The context as the turn left it, from the latest usage_update
    await expect(reviewer.getByRole('separator').filter({ hasText: /· cache 80% · context 61K \/ 200K$/ }).first()).toBeVisible()

    await pick(page, 'Set up the release workflow')
    const releaser = tab(page, 'Conversation')
    // The child session's thought, tool call and reply
    await expect(releaser.getByText('subagent · Check existing workflows', { exact: true })).toHaveCount(3)
    // Its two chunks join into one reply
    await expect(releaser.getByText(/^Only\s*ci\.yml\s*exists; it runs the tests on push and has no publish job\.$/)).toHaveCount(2)
    // The task tool shows that reply as markdown, without opencode's <subagent> wrapper
    const task = releaser.locator('.ant-collapse-item').filter({ has: page.getByText('subagent', { exact: true }) })
    await expect(task.locator('code', { hasText: /^ci\.yml$/ })).toHaveCount(1)
    await expect(task).not.toContainText('`ci.yml`')
  })

  test('W10 the conversation tab is monospace throughout; the rest of the page keeps the system font', async ({ page }) => {
    await openPage(page)
    await pick(page, 'Add input validation')
    const panel = tab(page, 'Conversation')
    const tool = (title: RegExp) => panel.locator('.ant-collapse-item').filter({ has: page.getByRole('button', { name: title }) }).first()
    const diff = panel.locator('pre').filter({ hasText: '@@ -0,0 +1,5 @@' })
    const monospace: Array<[string, Locator, string]> = [
      ['reply', panel.locator('.x-markdown p').filter({ hasText: 'I\'ll start by reading the handler' }), '12px'],
      ['thinking', panel.getByText(/^The route inserts the body as-is/), '12px'],
      ['tool title', panel.getByText('Read src/api/users.ts', { exact: true }), '12px'],
      ['tool output', tool(/^check-circle npm test/).getByText(/^PASS test\/users\.test\.ts/), '12px'],
      ['tag', panel.locator('.ant-tag').filter({ hasText: /^reply$/ }), '10px'],
      ['code block pre', panel.locator('.x-markdown pre').filter({ hasText: 'export function validateUser' }), '12px'],
      ['code block code', panel.locator('.x-markdown pre code').filter({ hasText: 'export function validateUser' }), '12px'],
      ['diff pre', diff, '12px'],
      ['diff code', diff.locator('code'), '12px'],
    ]
    for (const [name, locator, size] of monospace) {
      const [family, fontSize] = await font(locator)
      expect(family, name).toMatch(MONO)
      expect(fontSize, name).toBe(size)
    }
    const system: Array<[string, Locator]> = [
      ['session list', page.getByRole('menuitem', { name: /^Add input validation/ })],
      ['page header', page.getByRole('banner')],
      ['tab title', page.getByRole('tab', { name: 'Conversation' })],
    ]
    for (const [name, locator] of system) expect((await font(locator))[0], name).not.toMatch(/Sarasa Mono SC/)

    // Chinese and Japanese text asks for the same monospace family; the 2:1 width needs the font installed
    await pick(page, '把 src/api/users.ts')
    const cjk = tab(page, 'Conversation')
    const texts: Array<[string, Locator]> = [
      ['simplified reply', cjk.locator('.x-markdown p').filter({ hasText: '已在 POST 与 PATCH 路由加入校验' })],
      ['simplified table', cjk.locator('.x-markdown td').filter({ hasText: '新增，校验' })],
      ['traditional reply', cjk.locator('.x-markdown p').filter({ hasText: '已更新用戶資料的檢查' })],
      ['japanese reply', cjk.locator('.x-markdown p').filter({ hasText: 'バリデーションを追加しました' })],
      ['tool title', cjk.getByText('读取 src/api/users.ts 的校验逻辑', { exact: true })],
      ['code comment', cjk.locator('.x-markdown pre').filter({ hasText: '// 名称不超过 80 个字符' })],
    ]
    for (const [name, locator] of texts) expect((await font(locator))[0], name).toMatch(MONO)
    await page.getByRole('tab', { name: 'Session' }).click()
    const capabilities = tab(page, 'Session').locator('pre').filter({ hasText: '"loadSession"' })
    for (const locator of [capabilities, capabilities.locator('code')]) expect((await font(locator))[0], 'capabilities').not.toMatch(/Sarasa Mono SC/)
  })

  test('W11 a tool\'s status icon lines up with the first line of its title', async ({ page }) => {
    await openPage(page)
    await pick(page, 'Tidy the changelog entries')
    const panel = tab(page, 'Conversation')
    const header = (title: string) => panel.locator('.ant-collapse-header').filter({ hasText: title })
    // The status icon, not the Collapse arrow, which antd already puts on the first line
    const status = (scope: Locator) => scope.getByRole('img', { name: /^(check-circle|close-circle|loading|minus-circle)$/ })
    // The flex item holding the title spans whole lines; the <strong> inside is inline and only as tall as its glyphs
    const titleOf = (scope: Locator, title: RegExp) => scope.locator('.ant-typography').filter({ hasText: title })
    const long = header('Search CHANGELOG.md for entries')
    const title = titleOf(long, /^Search CHANGELOG\.md for entries/)
    const lineHeight = await title.evaluate(el => Number.parseFloat(getComputedStyle(el).lineHeight))
    const box = await title.boundingBox()
    expect(box && box.height >= lineHeight * 1.5, 'the long title wraps').toBe(true)
    const firstLine = (box?.y ?? Number.NaN) + lineHeight / 2
    expect(Math.abs(await center(status(long)) - firstLine)).toBeLessThanOrEqual(2)

    const short = header('Read CHANGELOG.md')
    expect(Math.abs(await center(status(short)) - await center(titleOf(short, /^Read CHANGELOG\.md$/)))).toBeLessThanOrEqual(2)
  })

  test('W12 a single newline breaks the line in replies, thinking and plans; code blocks keep their lines', async ({ page }) => {
    await openPage(page)
    await pick(page, 'Tidy the changelog entries')
    const panel = tab(page, 'Conversation')
    const cases: Array<[string, Locator, [string, string]]> = [
      ['reply', panel.locator('.x-markdown').filter({ hasText: 'Rewrote 9 entries.' }), ['Rewrote 9 entries.', 'Grouped them']],
      ['thinking', panel.locator('.x-markdown').filter({ hasText: 'The entries mix tenses.' }), ['The entries mix tenses.', 'Past tense reads']],
      ['plan', panel.locator('.x-markdown').filter({ hasText: 'Rewrite the entries in past tense.' }), ['Rewrite the entries', 'Sort them by area.']],
    ]
    for (const [name, scope, texts] of cases) {
      const [first, second] = await lineTops(scope, texts)
      expect(first !== null && second !== null && second > first, name).toBe(true)
    }
    const code = panel.locator('pre').filter({ hasText: 'Fixed the navbar overflow' }).first()
    expect((await code.innerText()).trim().split('\n')).toEqual(['- Fixed the navbar overflow', '- Moved billing to the v2 client'])
  })

  test('W14 a turn still running when the agent exits ends with a closed divider', async ({ page }) => {
    await openPage(page)
    await expect(page.getByRole('menuitem', { name: /^Build the docs site\. CLOSED$/ })).toBeVisible()
    await pick(page, 'Build the docs site')
    const panel = tab(page, 'Conversation')
    await expect(panel.getByRole('separator').last()).toHaveText(/^turn \d+ · closed · exited/)
  })

  test('W13 the turn divider shows how long the turn took, before the tokens', async ({ page }) => {
    await openPage(page)
    await pick(page, 'Tidy the changelog entries')
    const panel = tab(page, 'Conversation')
    for (const duration of ['1m 23s', '8.2s']) {
      await expect(panel.getByRole('separator').filter({ hasText: new RegExp(`^turn \\d+ · done · end_turn · ${duration.replace('.', '\\.')} · \\S+ tokens`) })).toHaveCount(1)
    }
    // The divider text reads like the rest of the conversation, not in antd's larger, heavier divider style
    const look = (locator: Locator) => locator.first().evaluate(el => [getComputedStyle(el).fontFamily, getComputedStyle(el).fontSize, getComputedStyle(el).fontWeight])
    const divider = panel.getByRole('separator').filter({ hasText: '1m 23s' }).locator('.ant-divider-inner-text')
    expect(await look(divider)).toEqual(await look(panel.locator('.x-markdown p').filter({ hasText: 'The dates are in order.' })))
  })
})
