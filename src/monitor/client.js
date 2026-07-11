import net from 'net'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { EventEmitter } from 'events'

const SOCK_DIR = path.join(os.homedir(), '.tui-mcp')
const SCAN_MS = 2000
const REQUEST_TIMEOUT_MS = 5000

function pidFromSock(file) {
  const m = file.match(/^(\d+)\.sock$/)
  return m ? Number(m[1]) : null
}

function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

export function connect() {
  const emitter = new EventEmitter()
  const connections = new Map()
  const pending = new Map()
  let nextReqId = 1
  let destroyed = false
  let scanTimer = null

  function scanAndConnect() {
    if (destroyed) return

    let files = []
    try { files = fs.readdirSync(SOCK_DIR).filter(f => f.endsWith('.sock')) } catch {}

    for (const file of files) {
      const sockPath = path.join(SOCK_DIR, file)
      if (connections.has(sockPath)) continue

      const pid = pidFromSock(file)
      if (pid && !isProcessAlive(pid)) {
        try { fs.unlinkSync(sockPath) } catch {}
        continue
      }

      connectOne(sockPath)
    }

    scanTimer = setTimeout(scanAndConnect, SCAN_MS)
  }

  function settleResult(msg) {
    const req = pending.get(msg.reqId)
    if (!req) return
    pending.delete(msg.reqId)
    clearTimeout(req.timer)
    if (msg.ok) req.resolve(msg.data)
    else req.reject(new Error(msg.error || 'request failed'))
  }

  function connectOne(sockPath) {
    let buffer = ''
    const socket = net.createConnection(sockPath)
    connections.set(sockPath, socket)

    socket.on('data', (chunk) => {
      buffer += chunk.toString()
      let nl
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        try {
          const msg = JSON.parse(line)
          if (msg.type === 'result') {
            settleResult(msg)
            continue
          }
          msg._source = sockPath
          emitter.emit('message', msg)
        } catch {}
      }
    })

    socket.on('error', () => {
      socket.destroy()
    })

    socket.on('close', () => {
      connections.delete(sockPath)
      emitter.emit('server_lost', sockPath)
    })

    socket.on('connect', () => {
      emitter.emit('connected', sockPath)
    })
  }

  scanAndConnect()

  emitter.send = (source, msg) => {
    const socket = connections.get(source)
    if (!socket) return false
    try { socket.write(JSON.stringify(msg) + '\n'); return true } catch { return false }
  }

  emitter.request = (source, msg) => {
    return new Promise((resolve, reject) => {
      const socket = connections.get(source)
      if (!socket) return reject(new Error('server not connected'))

      const reqId = nextReqId++
      const timer = setTimeout(() => {
        pending.delete(reqId)
        reject(new Error('request timed out'))
      }, REQUEST_TIMEOUT_MS)

      pending.set(reqId, { resolve, reject, timer })

      try {
        socket.write(JSON.stringify({ ...msg, reqId }) + '\n')
      } catch (e) {
        pending.delete(reqId)
        clearTimeout(timer)
        reject(e)
      }
    })
  }

  emitter.destroy = () => {
    destroyed = true
    clearTimeout(scanTimer)
    for (const req of pending.values()) {
      clearTimeout(req.timer)
      req.reject(new Error('client destroyed'))
    }
    pending.clear()
    for (const socket of connections.values()) {
      try { socket.destroy() } catch {}
    }
    connections.clear()
  }

  return emitter
}
