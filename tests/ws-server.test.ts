import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WebSocket, { type WebSocketServer } from 'ws'
import type { OnAirPlatform } from '../src/platform.js'

// Mock @homebridge/ciao before importing OnAirServer
vi.mock('@homebridge/ciao', () => ({
  getResponder: () => ({
    createService: () => ({
      advertise: vi.fn().mockResolvedValue(undefined),
      end: vi.fn().mockResolvedValue(undefined),
    }),
  }),
}))

// Import after mock is set up (vitest hoists vi.mock, but being explicit)
const { OnAirServer } = await import('../src/ws-server.js')

function createMockPlatform(port = 0) {
  const mockUpdateState = vi.fn()
  const mockClearState = vi.fn()
  const mockOccupantAccessory = { updateState: mockUpdateState, clearState: mockClearState }

  const mockPlatform = {
    config: { port },
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    getOccupantAccessory: vi.fn((id: string) => {
      if (id === 'aaron') return mockOccupantAccessory
      return undefined
    }),
  } as unknown as OnAirPlatform

  return { mockPlatform, mockOccupantAccessory, mockUpdateState, mockClearState }
}

function getServerPort(server: InstanceType<typeof OnAirServer>): number {
  const wss = (server as unknown as { wss: WebSocketServer | null }).wss
  const addr = wss?.address()
  return typeof addr === 'object' ? addr.port : 0
}

function connectWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`)
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

function sendJson(ws: WebSocket, msg: object): void {
  ws.send(JSON.stringify(msg))
}

function waitForMessage(ws: WebSocket, timeout = 2000): Promise<object> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for message')), timeout)
    ws.once('message', (raw) => {
      clearTimeout(timer)
      resolve(JSON.parse(raw.toString()))
    })
  })
}

function waitForClose(ws: WebSocket, timeout = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve()
      return
    }
    const timer = setTimeout(() => reject(new Error('Timed out waiting for close')), timeout)
    ws.once('close', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

describe('OnAirServer', () => {
  let server: InstanceType<typeof OnAirServer>
  let clients: WebSocket[]

  beforeEach(() => {
    clients = []
  })

  afterEach(async () => {
    // Close all test clients
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.terminate()
      }
    }
    clients = []

    // Stop the server
    if (server) {
      await server.stop()
    }

    vi.restoreAllMocks()
  })

  async function startServer(port = 0) {
    const mocks = createMockPlatform(port)
    server = new OnAirServer(mocks.mockPlatform)
    await server.start()
    const actualPort = getServerPort(server)
    return { ...mocks, actualPort }
  }

  async function connect(port: number): Promise<WebSocket> {
    const ws = await connectWs(port)
    clients.push(ws)
    return ws
  }

  async function identifyAndConnect(port: number, id = 'aaron'): Promise<WebSocket> {
    const ws = await connect(port)
    sendJson(ws, { type: 'identify', id })
    await waitForMessage(ws) // consume welcome
    return ws
  }

  describe('identify', () => {
    it('sends welcome for valid occupant', async () => {
      const { actualPort } = await startServer()
      const ws = await connect(actualPort)

      sendJson(ws, { type: 'identify', id: 'aaron' })
      const response = await waitForMessage(ws)

      expect(response).toEqual({ type: 'welcome', version: '1' })
    })

    it('sends error and closes for unknown occupant', async () => {
      const { actualPort } = await startServer()
      const ws = await connect(actualPort)

      sendJson(ws, { type: 'identify', id: 'unknown-person' })
      const response = await waitForMessage(ws)

      expect(response).toEqual({ type: 'error', message: 'unknown occupant id' })
      await waitForClose(ws)
    })

    it('sends error when non-identify message sent first', async () => {
      const { actualPort } = await startServer()
      const ws = await connect(actualPort)

      sendJson(ws, { type: 'status', onCall: true, muted: false })
      const response = await waitForMessage(ws)

      expect(response).toEqual({ type: 'error', message: 'must identify first' })
      await waitForClose(ws)
    })

    it('sends error for invalid message before identify', async () => {
      const { actualPort } = await startServer()
      const ws = await connect(actualPort)

      ws.send('not json')
      const response = await waitForMessage(ws)

      expect(response).toEqual({ type: 'error', message: 'invalid message' })
    })
  })

  describe('status', () => {
    it('sends ack and calls updateState', async () => {
      const { actualPort, mockUpdateState } = await startServer()
      const ws = await identifyAndConnect(actualPort)

      sendJson(ws, { type: 'status', onCall: true, muted: false })
      const response = await waitForMessage(ws)

      expect(response).toEqual({ type: 'ack' })
      expect(mockUpdateState).toHaveBeenCalledWith(true, false)
    })

    it('passes correct args for muted status', async () => {
      const { actualPort, mockUpdateState } = await startServer()
      const ws = await identifyAndConnect(actualPort)

      sendJson(ws, { type: 'status', onCall: true, muted: true })
      await waitForMessage(ws)

      expect(mockUpdateState).toHaveBeenCalledWith(true, true)
    })

    it('passes correct args for not-on-call status', async () => {
      const { actualPort, mockUpdateState } = await startServer()
      const ws = await identifyAndConnect(actualPort)

      sendJson(ws, { type: 'status', onCall: false, muted: false })
      await waitForMessage(ws)

      expect(mockUpdateState).toHaveBeenCalledWith(false, false)
    })
  })

  describe('ping', () => {
    it('sends pong after identify', async () => {
      const { actualPort } = await startServer()
      const ws = await identifyAndConnect(actualPort)

      sendJson(ws, { type: 'ping' })
      const response = await waitForMessage(ws)

      expect(response).toEqual({ type: 'pong' })
    })
  })

  describe('last-writer-wins', () => {
    it('terminates first connection when second identifies with same id', async () => {
      const { actualPort } = await startServer()

      // First connection
      const ws1 = await identifyAndConnect(actualPort, 'aaron')
      // Second connection with same id
      const ws2 = await connect(actualPort)
      sendJson(ws2, { type: 'identify', id: 'aaron' })
      const response = await waitForMessage(ws2)

      expect(response).toEqual({ type: 'welcome', version: '1' })

      // First connection should be terminated
      await waitForClose(ws1)
    })
  })

  describe('stale detection', () => {
    it('calls clearState after 15s of inactivity', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })

      const { actualPort, mockClearState } = await startServer()
      await identifyAndConnect(actualPort)

      // clearState may have been called from previous test setup — clear it
      mockClearState.mockClear()

      // Advance time by 15 seconds to trigger the stale timer
      vi.advanceTimersByTime(15_000)

      // Allow any microtasks to flush
      await vi.advanceTimersByTimeAsync(0)

      expect(mockClearState).toHaveBeenCalled()

      vi.useRealTimers()
    })

    it('resets stale timer on status message', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })

      const { actualPort, mockClearState } = await startServer()
      const ws = await identifyAndConnect(actualPort)
      mockClearState.mockClear()

      // Advance 10 seconds (not enough to trigger stale)
      vi.advanceTimersByTime(10_000)
      expect(mockClearState).not.toHaveBeenCalled()

      // Send a status to reset the timer
      sendJson(ws, { type: 'status', onCall: true, muted: false })
      await waitForMessage(ws) // consume ack

      mockClearState.mockClear()

      // Advance 10 more seconds — shouldn't trigger because timer was reset
      vi.advanceTimersByTime(10_000)
      expect(mockClearState).not.toHaveBeenCalled()

      // Advance 5 more seconds — now should trigger (15s from last activity)
      vi.advanceTimersByTime(5_000)
      await vi.advanceTimersByTimeAsync(0)
      expect(mockClearState).toHaveBeenCalled()

      vi.useRealTimers()
    })
  })

  describe('connection close', () => {
    it('calls clearState when identified client disconnects', async () => {
      const { actualPort, mockClearState } = await startServer()
      const ws = await identifyAndConnect(actualPort)
      mockClearState.mockClear()

      ws.close()
      await waitForClose(ws)

      // Small delay to let the server-side close handler run
      await new Promise((r) => setTimeout(r, 50))

      expect(mockClearState).toHaveBeenCalled()
    })
  })

  describe('stop', () => {
    it('terminates all connections on stop()', async () => {
      const { actualPort } = await startServer()
      const ws = await identifyAndConnect(actualPort)

      await server.stop()

      // Connection should be terminated
      await waitForClose(ws)
    })
  })
})
