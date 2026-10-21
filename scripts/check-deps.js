// Fail unless the ACP adapters bundled into dist/ resolve to the versions verified by `npm test` and the
// e2e suites. Update VERIFIED only after they pass on the candidate (README: Supported agents).
import { execFileSync } from 'node:child_process'

const VERIFIED = {
  '@agentclientprotocol/codex-acp': '2.2.2',
  '@agentclientprotocol/claude-agent-acp': '0.93.0',
}

const tree = JSON.parse(execFileSync('npm', ['ls', ...Object.keys(VERIFIED), '--json'], { encoding: 'utf-8' }))
const resolved = Object.fromEntries(Object.keys(VERIFIED).map(name => [name, tree.dependencies?.[name]?.version]))

const mismatches = Object.entries(VERIFIED).filter(([name, version]) => resolved[name] !== version)
mismatches.forEach(([name, version]) => console.error(`${name}: resolved ${resolved[name] ?? 'missing'}, verified ${version}`))
if (mismatches.length > 0) process.exit(1)
console.error('bundled ACP adapter versions match the verified set')
