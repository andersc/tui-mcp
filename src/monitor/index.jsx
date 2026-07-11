import {
  mount, createSignal, useInput, useInterval, useLayout, useToast,
  List, ScrollableText, TextInput, Spinner, Spacer,
} from '@trendr/core'
import {
  sessions, servers, buffers,
  serverPid, isControllable, onEvent,
  writeStdin, killSession, launchSession, fetchScrollback,
} from './store.js'
import { ACCENT, FG, FG_SOFT, MUTED, FAINT, PANEL_BG, SELECT_BG, RED, AMBER } from './theme.js'

const KILL_ARM_MS = 3000

let notify = null
onEvent(e => notify?.(e))

function timeAgo(ts) {
  if (!ts) return ''
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

function shortCommand(command) {
  return (command || '').replace(/\s+/g, ' ').trim()
}

function controllableSources() {
  return Object.keys(servers()).filter(isControllable)
}

function App() {
  const [selected, setSelected] = createSignal(0)
  const [mode, setMode] = createSignal('browse')
  const [scrollback, setScrollback] = createSignal('')
  const [launchTarget, setLaunchTarget] = createSignal(null)
  const refs = createSignal({})[0]()
  const [tick, setTick] = createSignal(0)

  void tick()
  useInterval(() => setTick(t => t + 1), 5000)

  const toast = useToast({
    duration: 3500,
    position: 'top-right',
    render: (message) => <text style={{ bg: ACCENT, color: 'black', bold: true }}>{` ${message} `}</text>,
  })

  const current = () => {
    const list = sessions()
    if (list.length === 0) return null
    return list[Math.min(selected(), list.length - 1)]
  }

  const currentBuffer = () => {
    const s = current()
    return s ? buffers()[s._key] || '' : ''
  }

  notify = (e) => {
    if (e.kind === 'created') toast(`▪ ${shortCommand(e.session.command).slice(0, 40)}`)
    if (e.kind === 'exited') {
      const s = sessions().find(x => x._key === e.key)
      const cmd = shortCommand(s?.command || '').slice(0, 40)
      toast(`${e.exitCode === 0 ? '✓' : '✗'} ${cmd} · exit ${e.exitCode}`)
      if (mode() === 'attach' && s && current()?._key === e.key) setMode('browse')
    }
  }

  const requireControl = (s) => {
    if (isControllable(s._source)) return true
    toast(`srv ${serverPid(s._source)} is read-only · restart it on 1.2+`)
    return false
  }

  const attach = () => {
    const s = current()
    if (!s) return
    if (s.exited) return toast('session has exited')
    if (!requireControl(s)) return
    setMode('attach')
  }

  const openScrollback = async () => {
    const s = current()
    if (!s) return
    if (!requireControl(s)) return
    try {
      const { text } = await fetchScrollback(s)
      setScrollback(text)
      setMode('scrollback')
    } catch (e) {
      toast(`scrollback failed · ${e.message}`)
    }
  }

  const openLaunch = () => {
    const candidates = controllableSources()
    if (candidates.length === 0) return toast('no controllable servers · restart them on 1.2+')
    const s = current()
    const preferred = s && isControllable(s._source) ? s._source : candidates[0]
    setLaunchTarget(preferred)
    setMode('launch')
  }

  const cycleLaunchTarget = () => {
    const candidates = controllableSources()
    if (candidates.length < 2) return
    const i = candidates.indexOf(launchTarget())
    setLaunchTarget(candidates[(i + 1) % candidates.length])
  }

  const submitLaunch = async (command) => {
    const cmd = command.trim()
    if (!cmd) return setMode('browse')
    try {
      await launchSession(launchTarget(), cmd)
      setMode('browse')
    } catch (e) {
      toast(`launch failed · ${e.message}`)
    }
  }

  const armKill = () => {
    const s = current()
    if (!s) return
    if (!requireControl(s)) return
    const armed = refs.killArm
    if (!armed || armed.key !== s._key || Date.now() - armed.at > KILL_ARM_MS) {
      refs.killArm = { key: s._key, at: Date.now() }
      return toast(`x again to kill ${shortCommand(s.command).slice(0, 30)}`)
    }
    refs.killArm = null
    killSession(s)
  }

  useInput((e) => {
    if (mode() === 'attach') {
      if (e.raw === '\x1c') return setMode('browse')
      const s = current()
      if (!s) return setMode('browse')
      if (e.key === 'paste') return writeStdin(s, e.text)
      if (e.raw) writeStdin(s, e.raw)
      return
    }

    if (mode() === 'launch') {
      if (e.ctrl && e.key === 's') cycleLaunchTarget()
      return
    }

    if (mode() === 'scrollback') {
      if (e.key === 'escape' || e.key === 'q') setMode('browse')
      return
    }

    if (e.key === 'return') attach()
    if (e.key === 's') openScrollback()
    if (e.key === 'l') openLaunch()
    if (e.key === 'x') armKill()
    if (e.key === 'q' || (e.ctrl && e.key === 'c')) process.exit(0)
  })

  if (mode() === 'attach') return <AttachView session={current()} content={currentBuffer()} />

  return (
    <box style={{ flexDirection: 'column', height: '100%' }}>
      <Header />
      <box style={{ flexDirection: 'row', flexGrow: 1, paddingX: 2, gap: 2, marginTop: 1 }}>
        <box style={{ flexDirection: 'column', width: 44 }}>
          {sessions().length === 0
            ? <EmptyList />
            : <List
                items={sessions()}
                selected={selected()}
                onSelect={setSelected}
                focused={mode() === 'browse'}
                scrolloff={2}
                renderItem={(item, ctx) => <SessionRow session={item} ctx={ctx} />}
              />}
        </box>
        <box style={{ flexDirection: 'column', flexGrow: 1, bg: PANEL_BG, paddingX: 1 }}>
          <PreviewHeader session={current()} mode={mode()} />
          {mode() === 'scrollback'
            ? <ScrollableText content={scrollback()} focused scrollbar wrap={false} />
            : <LivePreview session={current()} content={currentBuffer()} />}
        </box>
      </box>
      {mode() === 'launch' && <LaunchPanel target={launchTarget()} onSubmit={submitLaunch} onCancel={() => setMode('browse')} />}
      <Footer mode={mode()} />
    </box>
  )
}

function Header() {
  const total = Object.keys(servers()).length
  const controllable = controllableSources().length
  const readOnly = total - controllable

  return (
    <box style={{ flexDirection: 'row', paddingX: 2, marginTop: 1 }}>
      <text style={{ color: ACCENT, bold: true }}>tui-mcp</text>
      <text style={{ color: MUTED }}> monitor</text>
      <Spacer />
      <text style={{ color: FG_SOFT }}>{`${sessions().length} sessions`}</text>
      <text style={{ color: FAINT }}> · </text>
      <text style={{ color: FG_SOFT }}>{`${total} servers`}</text>
      {readOnly > 0 && <text style={{ color: AMBER }}>{` · ${readOnly} read-only`}</text>}
    </box>
  )
}

function EmptyList() {
  const total = Object.keys(servers()).length

  return (
    <box style={{ flexDirection: 'column', marginTop: 1 }}>
      <text style={{ color: FAINT }}>no sessions yet</text>
      <text style={{ color: FAINT }}>agents create them with the launch tool</text>
      <box style={{ flexDirection: 'row', marginTop: 1 }}>
        {total === 0
          ? <Spinner color={MUTED} label="waiting for servers..." />
          : <text style={{ color: MUTED }}>{`▪ ${total} server${total === 1 ? '' : 's'} connected`}</text>}
      </box>
    </box>
  )
}

function SessionRow({ session, ctx }) {
  const bg = ctx.selected ? (ctx.focused ? ACCENT : SELECT_BG) : null
  const fg = ctx.selected ? 'black' : null
  const dot = session.exited ? '▫ ' : '▪ '
  const dotColor = fg || (session.exited ? FAINT : ACCENT)
  const meta = [
    `srv ${serverPid(session._source)}`,
    isControllable(session._source) ? null : 'ro',
    timeAgo(session.createdAt),
  ].filter(Boolean).join(' · ')

  return (
    <box style={{ flexDirection: 'row', bg, paddingX: 1 }}>
      <text style={{ color: dotColor }}>{dot}</text>
      <box style={{ flexGrow: 1, height: 1 }}>
        <text style={{ overflow: 'truncate', color: fg || (session.exited ? FG_SOFT : FG) }}>
          {shortCommand(session.command)}
        </text>
      </box>
      <text style={{ color: fg || FAINT, dim: !ctx.selected }}>{`  ${meta}`}</text>
    </box>
  )
}

function PreviewHeader({ session, mode }) {
  if (!session) return <text style={{ color: FAINT }}>nothing selected</text>

  return (
    <box style={{ flexDirection: 'row' }}>
      <box style={{ flexGrow: 1, height: 1 }}>
        <text style={{ overflow: 'truncate', color: ACCENT, bold: true }}>{shortCommand(session.command)}</text>
      </box>
      {mode === 'scrollback' && <text style={{ bg: ACCENT, color: 'black', bold: true }}> scrollback </text>}
      <text style={{ color: MUTED }}>{`  pid ${session.pid} · ${session.cols}x${session.rows}`}</text>
      <SessionStatus session={session} />
    </box>
  )
}

function SessionStatus({ session }) {
  if (!session.exited) return <text style={{ color: ACCENT }}>{'  ▪'}</text>
  const ok = session.exitCode === 0
  return (
    <text style={{ color: ok ? MUTED : RED }}>
      {`  ${ok ? '✓' : '✗'} exit ${session.exitCode}`}
    </text>
  )
}

// published ScrollableText renders a controlled offset unclamped, so pin the
// tail by computing the real offset from the available height
function TailText({ content }) {
  const rect = useLayout()
  const lineCount = content.split('\n').length
  const offset = Math.max(0, lineCount - Math.max(1, rect.height || 1))
  return <ScrollableText content={content} focused={false} scrollOffset={offset} wrap={false} />
}

function LivePreview({ session, content }) {
  if (!session) {
    return <text style={{ color: FAINT, marginTop: 1 }}>select a session to see its terminal</text>
  }
  if (!content) {
    return <text style={{ color: FAINT, marginTop: 1 }}>no output yet</text>
  }
  return <TailText content={content} />
}

function AttachView({ session, content }) {
  if (!session) return <text style={{ color: FAINT }}>session is gone</text>

  return (
    <box style={{ flexDirection: 'column', height: '100%' }}>
      <box style={{ flexDirection: 'row', paddingX: 2, marginTop: 1 }}>
        <box style={{ flexGrow: 1, height: 1 }}>
          <text style={{ overflow: 'truncate', color: ACCENT, bold: true }}>{shortCommand(session.command)}</text>
        </box>
        <text style={{ color: MUTED }}>{`pid ${session.pid} · ${session.cols}x${session.rows}  `}</text>
        <text style={{ bg: ACCENT, color: 'black', bold: true }}> attached </text>
      </box>
      <box style={{ flexGrow: 1, bg: PANEL_BG, paddingX: 1, marginTop: 1 }}>
        <TailText content={content} />
      </box>
      <box style={{ flexDirection: 'row', paddingX: 2, marginTop: 1 }}>
        <text style={{ color: FAINT }}>ctrl+\ to detach · every other key passes through</text>
      </box>
    </box>
  )
}

function LaunchPanel({ target, onSubmit, onCancel }) {
  return (
    <box style={{ flexDirection: 'column', paddingX: 2, marginTop: 1 }}>
      <box style={{ flexDirection: 'row' }}>
        <text style={{ color: ACCENT, bold: true }}>launch</text>
        <Spacer />
        <text style={{ color: MUTED }}>{`▪ srv ${serverPid(target)}`}</text>
      </box>
      <text style={{ color: MUTED }}>enter to launch · ctrl+s to switch server · esc to cancel</text>
      <box style={{ bg: PANEL_BG, paddingX: 1, marginTop: 1 }}>
        <TextInput
          focused
          clearOnSubmit
          placeholder="command, e.g. htop"
          onSubmit={onSubmit}
          onCancel={onCancel}
        />
      </box>
    </box>
  )
}

const FOOTER_HINTS = {
  browse: '↑↓ move · enter attach · s scrollback · l launch · x kill · q quit',
  scrollback: '↑↓ scroll · g/G top/bottom · esc back to live',
  launch: 'type a command · enter to launch · esc to cancel',
}

function Footer({ mode }) {
  return (
    <box style={{ flexDirection: 'row', paddingX: 2, marginTop: 1 }}>
      <text style={{ color: FAINT }}>{FOOTER_HINTS[mode] || FOOTER_HINTS.browse}</text>
      <Spacer />
      <text style={{ color: FAINT }}>tui-mcp</text>
    </box>
  )
}

mount(App, { title: 'tui-mcp monitor', theme: { accent: ACCENT, muted: MUTED } })
