import { defineConfig, devices } from '@playwright/test'

// Three browser layers, told apart by who answers as the agent and whether you can watch it.
// Unit tests stay on node:test (npm run test:unit); test/specs holds only the browser layers.
export default defineConfig({
  testDir: './test/specs',
  testMatch: '**/*.spec.ts',
  // One webui per spec file and MCP servers spawned per test: run them one at a time
  fullyParallel: false,
  workers: 1,
  outputDir: './.test/test-results',
  reporter: [
    ['list'],
    ['html', { outputFolder: '.test/playwright-report', open: 'never' }],
  ],
  use: {
    ...devices['Desktop Chrome'],
    // The local Google Chrome; no browser download
    channel: 'chrome',
    viewport: { width: 1400, height: 900 },
    // A locator that never resolves fails in seconds with the call log, instead of hanging the run
    actionTimeout: 20_000,
    screenshot: 'only-on-failure',
  },
  projects: [
    // npm run test:mock -- fake MCP servers from mock/webui.ts feed a real webui; headless
    { name: 'mock', testMatch: 'mock/**/*.spec.ts', use: { headless: true }, retries: 1 },
    // npm run test:fast -- dist/cli.js with the scripted agent, driven through MCP tools; headless
    { name: 'fast', testMatch: 'fast/**/*.spec.ts', use: { headless: true }, retries: 1 },
    // npm run test:e2e -- real agents, one window from start to finish. Turns take minutes: no test timeout
    { name: 'e2e', testMatch: 'e2e/**/*.spec.ts', use: { headless: false, trace: 'on', video: 'retain-on-failure' }, retries: 0, timeout: 0 },
  ],
})
