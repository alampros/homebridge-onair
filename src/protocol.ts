// Client → Server messages (discriminated union on `type`)

export interface IdentifyMessage {
  type: 'identify'
  id: string
}

export interface StatusMessage {
  type: 'status'
  onCall: boolean
  muted: boolean
}

export interface PingMessage {
  type: 'ping'
}

export type ClientMessage = IdentifyMessage | StatusMessage | PingMessage

// Server → Client messages

export interface WelcomeMessage {
  type: 'welcome'
  version: string
}

export interface ErrorMessage {
  type: 'error'
  message: string
}

export interface AckMessage {
  type: 'ack'
}

export interface PongMessage {
  type: 'pong'
}

export type ServerMessage = WelcomeMessage | ErrorMessage | AckMessage | PongMessage

/**
 * Safely parse and validate a client→server WebSocket message.
 * Returns null for any invalid input.
 */
export function parseClientMessage(data: string): ClientMessage | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return null
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return null
  }

  const obj = parsed as Record<string, unknown>

  switch (obj.type) {
    case 'identify':
      if (typeof obj.id === 'string' && obj.id.length > 0) {
        return { type: 'identify', id: obj.id }
      }
      return null

    case 'status':
      if (typeof obj.onCall === 'boolean' && typeof obj.muted === 'boolean') {
        return { type: 'status', onCall: obj.onCall, muted: obj.muted }
      }
      return null

    case 'ping':
      return { type: 'ping' }

    default:
      return null
  }
}
