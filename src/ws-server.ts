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
    this.wss = new WebSocketServer({ port: this.port })

    this.wss.on('connection', (ws: WebSocket) => {
      this.handleConnection(ws)
    })

    this.wss.on('error', (err: Error) => {
      this.platform.log.error('WebSocket server error:', err.message)
    })

    this.platform.log.info(`WebSocket server listening on port ${this.port}`)

    // Advertise via mDNS so companion apps can discover the server
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
    // Unadvertise mDNS before tearing down the server
    if (this.mdnsService) {
      await this.mdnsService.end()
      this.mdnsService = null
      this.platform.log.info('mDNS: unadvertised _onair._tcp')
    }

    // Terminate all tracked connections
    for (const [, ws] of this.connections) {
      ws.terminate()
    }
    this.connections.clear()

    // Clear all stale timers
    for (const [, timer] of this.staleTimers) {
      clearTimeout(timer)
    }
    this.staleTimers.clear()

    // Close the server itself
    await new Promise<void>((resolve) => {
      if (this.wss) {
        this.wss.close(() => resolve())
      } else {
        resolve()
      }
    })
  }

  private handleConnection(ws: WebSocket): void {
    let occupantId: string | null = null

    // Always attach error handler first to prevent crashes
    ws.on('error', (err: Error) => {
      this.platform.log.error('WebSocket connection error:', err.message)
    })

    ws.on('message', (raw: WebSocket.RawData) => {
      const data = raw.toString()
      const msg = parseClientMessage(data)

      if (!msg) {
        this.send(ws, { type: 'error', message: 'invalid message' })
        return
      }

      // Must identify first
      if (occupantId === null && msg.type !== 'identify') {
        this.send(ws, { type: 'error', message: 'must identify first' })
        ws.close()
        return
      }

      switch (msg.type) {
        case 'identify': {
          const accessory = this.platform.getOccupantAccessory(msg.id)
          if (!accessory) {
            this.send(ws, { type: 'error', message: 'unknown occupant id' })
            ws.close()
            return
          }

          // Last-writer-wins: terminate old connection if one exists
          const existing = this.connections.get(msg.id)
          if (existing && existing !== ws) {
            existing.terminate()
          }

          // Register this connection
          occupantId = msg.id
          this.connections.set(occupantId, ws)
          this.send(ws, { type: 'welcome', version: '1' })
          this.resetStaleTimer(occupantId)
          break
        }

        case 'status': {
          if (!occupantId) break
          const accessory = this.platform.getOccupantAccessory(occupantId)
          accessory?.updateState(msg.onCall, msg.muted)
          this.send(ws, { type: 'ack' })
          this.resetStaleTimer(occupantId)
          break
        }

        case 'ping': {
          if (!occupantId) break
          this.send(ws, { type: 'pong' })
          this.resetStaleTimer(occupantId)
          break
        }
      }
    })

    ws.on('close', () => {
      if (occupantId !== null) {
        // Only remove if this ws is still the active connection (last-writer-wins guard)
        if (this.connections.get(occupantId) === ws) {
          this.connections.delete(occupantId)

          // Clear stale timer
          clearTimeout(this.staleTimers.get(occupantId))
          this.staleTimers.delete(occupantId)

          // Clear sensors
          this.platform.getOccupantAccessory(occupantId)?.clearState()
        }
      }
    })
  }

  private resetStaleTimer(occupantId: string): void {
    clearTimeout(this.staleTimers.get(occupantId))
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
      ws.send(JSON.stringify(message))
    }
  }
}
