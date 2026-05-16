import type { CiaoService } from '@homebridge/ciao'
import { getResponder } from '@homebridge/ciao'
import WebSocket, { WebSocketServer } from 'ws'

import type { OnAirPlatform } from './platform.js'
import type { ServerMessage } from './protocol.js'
import { parseClientMessage } from './protocol.js'
import { DEFAULT_PORT } from './settings.js'

const STALE_TIMEOUT = 15_000 // 15 seconds

export class OnAirServer {
  private wss: WebSocketServer | null = null
  private mdnsService: CiaoService | null = null
  private readonly connections = new Map<string, WebSocket>()
  private readonly staleTimers = new Map<string, NodeJS.Timeout>()
  private readonly port: number

  constructor(private readonly platform: OnAirPlatform) {
    this.port = Number(platform.config.port) || DEFAULT_PORT
  }

  /** Create the WebSocket server and begin accepting connections. */
  async start(): Promise<void> {
    this.platform.log.debug('Creating WebSocket server on port %d...', this.port)
    this.wss = new WebSocketServer({ port: this.port })

    this.wss.on('connection', (ws: WebSocket, req) => {
      const remoteAddr = req.socket.remoteAddress ?? 'unknown'
      const remotePort = req.socket.remotePort ?? 0
      this.platform.log.info('[ws] New connection from %s:%d', remoteAddr, remotePort)
      this.handleConnection(ws)
    })

    this.wss.on('error', (err: Error) => {
      this.platform.log.error('WebSocket server error:', err.message)
    })

    this.platform.log.info(`WebSocket server listening on port ${this.port}`)

    // Advertise via mDNS so companion apps can discover the server
    this.platform.log.debug('[mdns] Creating mDNS responder and service (_onair._tcp, port %d)...', this.port)
    const responder = getResponder()
    this.mdnsService = responder.createService({
      name: 'OnAir',
      type: 'onair',
      port: this.port,
      txt: { v: '1' },
    })
    await this.mdnsService.advertise()
    this.platform.log.info('mDNS: advertising _onair._tcp on port %d', this.port)
  }

  /** Gracefully shut down the server and all connections. */
  async stop(): Promise<void> {
    this.platform.log.debug('[ws] Stopping server — %d active connection(s)', this.connections.size)

    // Unadvertise mDNS before tearing down the server
    if (this.mdnsService) {
      this.platform.log.debug('[mdns] Unadvertising _onair._tcp...')
      await this.mdnsService.end()
      this.mdnsService = null
      this.platform.log.info('mDNS: unadvertised _onair._tcp')
    }

    // Terminate all tracked connections
    for (const [id, ws] of this.connections) {
      this.platform.log.debug('[ws] Terminating connection for occupant "%s"', id)
      ws.terminate()
    }
    this.connections.clear()

    // Clear all stale timers
    this.platform.log.debug('[ws] Clearing %d stale timer(s)', this.staleTimers.size)
    for (const [, timer] of this.staleTimers) {
      clearTimeout(timer)
    }
    this.staleTimers.clear()

    // Close the server itself
    this.platform.log.debug('[ws] Closing WebSocket server...')
    await new Promise<void>((resolve) => {
      if (this.wss) {
        this.wss.close(() => resolve())
      } else {
        resolve()
      }
    })
    this.platform.log.debug('[ws] Server stopped')
  }

  private handleConnection(ws: WebSocket): void {
    let occupantId: string | null = null

    // Always attach error handler first to prevent crashes
    ws.on('error', (err: Error) => {
      this.platform.log.error('WebSocket connection error:', err.message)
      this.platform.log.debug('[ws] Connection error detail — occupantId=%s, readyState=%d', occupantId ?? '(unidentified)', ws.readyState)
    })

    ws.on('message', (raw: WebSocket.RawData) => {
      const data = raw.toString()
      this.platform.log.debug('[ws] Received message from occupant "%s": %s', occupantId ?? '(unidentified)', data)
      const msg = parseClientMessage(data)

      if (!msg) {
        this.platform.log.debug('[ws] Failed to parse message — sending error response')
        this.send(ws, { type: 'error', message: 'invalid message' })
        return
      }

      // Must identify first
      if (occupantId === null && msg.type !== 'identify') {
        this.platform.log.debug('[ws] Received "%s" before identify — rejecting and closing', msg.type)
        this.send(ws, { type: 'error', message: 'must identify first' })
        ws.close()
        return
      }

      switch (msg.type) {
        case 'identify': {
          this.platform.log.debug('[ws] Identify request for occupant "%s"', msg.id)
          const accessory = this.platform.getOccupantAccessory(msg.id)
          if (!accessory) {
            this.platform.log.debug('[ws] No accessory found for occupant "%s" — rejecting', msg.id)
            this.send(ws, { type: 'error', message: 'unknown occupant id' })
            ws.close()
            return
          }

          // Last-writer-wins: terminate old connection if one exists
          const existing = this.connections.get(msg.id)
          if (existing && existing !== ws) {
            this.platform.log.debug('[ws] Occupant "%s" already connected — terminating previous connection (last-writer-wins)', msg.id)
            existing.terminate()
          }

          // Register this connection
          occupantId = msg.id
          this.connections.set(occupantId, ws)
          this.platform.log.info('[ws] Occupant "%s" identified — sending welcome (total connections: %d)', occupantId, this.connections.size)
          this.send(ws, { type: 'welcome', version: '1' })
          this.resetStaleTimer(occupantId)
          break
        }

        case 'status': {
          if (!occupantId) break
          this.platform.log.debug('[ws] Status update from "%s": onCall=%s, muted=%s', occupantId, msg.onCall, msg.muted)
          const accessory = this.platform.getOccupantAccessory(occupantId)
          accessory?.updateState(msg.onCall, msg.muted)
          this.send(ws, { type: 'ack' })
          this.resetStaleTimer(occupantId)
          break
        }

        case 'ping': {
          if (!occupantId) break
          this.platform.log.debug('[ws] Ping from "%s" — sending pong', occupantId)
          this.send(ws, { type: 'pong' })
          this.resetStaleTimer(occupantId)
          break
        }
      }
    })

    ws.on('close', (code: number, reason: Buffer) => {
      const reasonStr = reason.toString() || '(none)'
      this.platform.log.info('[ws] Connection closed — occupant="%s", code=%d, reason=%s', occupantId ?? '(unidentified)', code, reasonStr)
      if (occupantId !== null) {
        // Only remove if this ws is still the active connection (last-writer-wins guard)
        if (this.connections.get(occupantId) === ws) {
          this.platform.log.debug(
            '[ws] Removing active connection for "%s" — clearing sensors (remaining connections: %d)',
            occupantId,
            this.connections.size - 1,
          )
          this.connections.delete(occupantId)

          // Clear stale timer
          clearTimeout(this.staleTimers.get(occupantId))
          this.staleTimers.delete(occupantId)

          // Clear sensors
          this.platform.getOccupantAccessory(occupantId)?.clearState()
        } else {
          this.platform.log.debug('[ws] Closed connection for "%s" was not the active connection — no cleanup needed', occupantId)
        }
      }
    })
  }

  private resetStaleTimer(occupantId: string): void {
    clearTimeout(this.staleTimers.get(occupantId))
    this.platform.log.debug('[ws] Resetting stale timer for "%s" (%dms)', occupantId, STALE_TIMEOUT)
    this.staleTimers.set(
      occupantId,
      setTimeout(() => {
        this.platform.getOccupantAccessory(occupantId)?.clearState()
        this.platform.log.warn(`Occupant ${occupantId} stale — clearing sensors`)
      }, STALE_TIMEOUT),
    )
  }

  private send(ws: WebSocket, message: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      const payload = JSON.stringify(message)
      this.platform.log.debug('[ws] Sending: %s', payload)
      ws.send(payload)
    } else {
      this.platform.log.debug('[ws] Cannot send — socket not open (readyState=%d): %s', ws.readyState, JSON.stringify(message))
    }
  }
}
