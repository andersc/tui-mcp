import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import net from 'net'
import path from 'path'
import os from 'os'
import * as session from '../src/session.js'
import { startIpc, SOCK_DIR } from '../src/ipc.js'

let server
let socket
let received = []
let waiters = []

function nextMessage(predicate, timeout = 5000) {
  const found = received.find(predicate)
  if (found) return Promise.resolve(found)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for message')), timeout)
    waiters.push({ predicate, resolve, timer })
  })
}

function send(msg) {
  socket.write(JSON.stringify(msg) + '\n')
}

before(async () => {
  server = startIpc()
  await new Promise(r => server.once('listening', r))

  socket = net.createConnection(path.join(SOCK_DIR, `${process.pid}.sock`))
  await new Promise(r => socket.once('connect', r))

  let buffer = ''
  socket.on('data', (chunk) => {
    buffer += chunk.toString()
    let nl
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      if (!line) continue
      const msg = JSON.parse(line)
      received.push(msg)
      waiters = waiters.filter(w => {
        if (!w.predicate(msg)) return true
        clearTimeout(w.timer)
        w.resolve(msg)
        return false
      })
    }
  })
})

after(() => {
  try { socket.destroy() } catch {}
  try { server.close() } catch {}
  for (const s of session.listSessions()) {
    try { session.kill(s.sessionId) } catch {}
  }
})

test('server announces itself with hello and caps', async () => {
  const hello = await nextMessage(m => m.type === 'hello')
  assert.equal(hello.pid, process.pid)
  assert.ok(hello.version)
  assert.ok(hello.caps.includes('control'))
})

test('launch command creates a session and broadcasts created', async () => {
  send({ type: 'launch', command: 'sleep 30', reqId: 101 })
  const result = await nextMessage(m => m.type === 'result' && m.reqId === 101)
  assert.equal(result.ok, true)
  assert.ok(result.data.sessionId)

  const created = await nextMessage(m => m.type === 'created' && m.session.sessionId === result.data.sessionId)
  assert.equal(created.session.command, 'sleep 30')
})

test('stdin command writes to the pty', async () => {
  send({ type: 'launch', command: 'cat', reqId: 102 })
  const { data } = await nextMessage(m => m.type === 'result' && m.reqId === 102)

  send({ type: 'stdin', sessionId: data.sessionId, data: 'echo-me\n' })
  await session.waitForText(data.sessionId, 'echo-me', 5000)
})

test('scrollback request returns buffer text', async () => {
  send({ type: 'launch', command: 'echo scroll-marker; sleep 30', reqId: 103 })
  const { data } = await nextMessage(m => m.type === 'result' && m.reqId === 103)
  await session.waitForText(data.sessionId, 'scroll-marker', 5000)

  send({ type: 'scrollback', sessionId: data.sessionId, reqId: 104 })
  const result = await nextMessage(m => m.type === 'result' && m.reqId === 104)
  assert.equal(result.ok, true)
  assert.match(result.data.text, /scroll-marker/)
})

test('resize command changes session dimensions', async () => {
  send({ type: 'launch', command: 'sleep 30', reqId: 105 })
  const { data } = await nextMessage(m => m.type === 'result' && m.reqId === 105)

  send({ type: 'resize', sessionId: data.sessionId, cols: 100, rows: 40, reqId: 106 })
  await nextMessage(m => m.type === 'result' && m.reqId === 106)

  const info = session.status(data.sessionId)
  assert.equal(info.cols, 100)
  assert.equal(info.rows, 40)
})

test('kill command removes the session and broadcasts killed', async () => {
  send({ type: 'launch', command: 'sleep 30', reqId: 107 })
  const { data } = await nextMessage(m => m.type === 'result' && m.reqId === 107)

  send({ type: 'kill', sessionId: data.sessionId })
  await nextMessage(m => m.type === 'killed' && m.sessionId === data.sessionId)
  assert.throws(() => session.status(data.sessionId))
})

test('failed command with reqId returns an error result', async () => {
  send({ type: 'kill', sessionId: 'nope', reqId: 108 })
  const result = await nextMessage(m => m.type === 'result' && m.reqId === 108)
  assert.equal(result.ok, false)
  assert.match(result.error, /no session/)
})

test('unknown command types are ignored without killing the connection', async () => {
  send({ type: 'bogus', reqId: 109 })
  send({ type: 'launch', command: 'sleep 30', reqId: 110 })
  const result = await nextMessage(m => m.type === 'result' && m.reqId === 110)
  assert.equal(result.ok, true)
})
