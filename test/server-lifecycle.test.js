import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const serverPath = path.join(import.meta.dirname, '..', 'src', 'server.js')
const socketDir = path.join(os.homedir(), '.tui-mcp')

function waitFor(predicate, timeout = 5000) {
  const deadline = Date.now() + timeout
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) return resolve()
      if (Date.now() >= deadline) return reject(new Error('condition was not met'))
      setTimeout(check, 20)
    }
    check()
  })
}

test('server exits and removes its monitor socket when MCP stdin closes', async (t) => {
  const child = spawn(process.execPath, [serverPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGKILL')
  })

  const socketPath = path.join(socketDir, `${child.pid}.sock`)
  await waitFor(() => fs.existsSync(socketPath))

  child.stdin.end()
  const [code, signal] = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not exit')), 5000)
    child.once('exit', (exitCode, exitSignal) => {
      clearTimeout(timer)
      resolve([exitCode, exitSignal])
    })
  })

  assert.equal(code, 0)
  assert.equal(signal, null)
  assert.equal(fs.existsSync(socketPath), false)
})
