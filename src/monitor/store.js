import { createSignal } from '@trendr/core'
import { connect } from './client.js'

const [sessions, setSessions] = createSignal([])
const [servers, setServers] = createSignal({})
const [buffers, setBuffers] = createSignal({})

export { sessions, servers, buffers }

function sessionKey(source, sessionId) {
  return `${source}:${sessionId}`
}

export function serverPid(source) {
  const m = (source || '').match(/(\d+)\.sock$/)
  return m ? m[1] : '?'
}

export function serverInfo(source) {
  return servers()[source]
}

export function isControllable(source) {
  return serverInfo(source)?.caps?.includes('control') ?? false
}

function sortSessions(list) {
  return [...list].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0) || a.pid - b.pid)
}

function decorate(source, s) {
  return { ...s, _source: source, _key: sessionKey(source, s.sessionId) }
}

function rememberServer(source, info = {}) {
  setServers(prev => ({ ...prev, [source]: { ...prev[source], ...info } }))
}

function forgetServer(source) {
  setServers(prev => {
    const next = { ...prev }
    delete next[source]
    return next
  })
  setSessions(prev => prev.filter(s => s._source !== source))
  setBuffers(prev => {
    const next = { ...prev }
    for (const k of Object.keys(next)) {
      if (k.startsWith(source + ':')) delete next[k]
    }
    return next
  })
}

const listeners = new Set()

export function onEvent(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function emit(event) {
  for (const fn of listeners) fn(event)
}

const client = connect()

client.on('connected', (source) => rememberServer(source))

client.on('server_lost', (source) => forgetServer(source))

client.on('message', (msg) => {
  const source = msg._source
  rememberServer(source)

  if (msg.type === 'hello') {
    rememberServer(source, { pid: msg.pid, version: msg.version, caps: msg.caps || [] })
  }

  if (msg.type === 'sessions') {
    setSessions(prev => {
      const other = prev.filter(s => s._source !== source)
      return sortSessions([...other, ...msg.sessions.map(s => decorate(source, s))])
    })
  }

  if (msg.type === 'created') {
    setSessions(prev => {
      const rest = prev.filter(s => s._key !== sessionKey(source, msg.session.sessionId))
      return sortSessions([...rest, decorate(source, msg.session)])
    })
    emit({ kind: 'created', session: decorate(source, msg.session) })
  }

  if (msg.type === 'killed') {
    const key = sessionKey(source, msg.sessionId)
    setSessions(prev => prev.filter(s => s._key !== key))
    setBuffers(prev => {
      const next = { ...prev }
      delete next[key]
      return next
    })
    emit({ kind: 'killed', key })
  }

  if (msg.type === 'exited') {
    const key = sessionKey(source, msg.sessionId)
    setSessions(prev => prev.map(s =>
      s._key === key ? { ...s, exited: true, exitCode: msg.exitCode } : s
    ))
    emit({ kind: 'exited', key, exitCode: msg.exitCode })
  }

  if (msg.type === 'buffer') {
    const key = sessionKey(source, msg.sessionId)
    const trimmed = msg.ansi.split('\n').map(l => l.replace(/ +(\x1b\[0m)?$/, '$1')).join('\n')
    setBuffers(prev => ({ ...prev, [key]: trimmed }))
  }
})

export function writeStdin(session, data) {
  client.send(session._source, { type: 'stdin', sessionId: session.sessionId, data })
}

export function killSession(session) {
  client.send(session._source, { type: 'kill', sessionId: session.sessionId })
}

export function resizeSession(session, cols, rows) {
  client.send(session._source, { type: 'resize', sessionId: session.sessionId, cols, rows })
}

export function launchSession(source, command, opts = {}) {
  return client.request(source, { type: 'launch', command, ...opts })
}

export function fetchScrollback(session, lines) {
  return client.request(session._source, { type: 'scrollback', sessionId: session.sessionId, lines })
}
