import { describe, expect, it } from 'vitest'
import { parseClientMessage } from '../src/protocol.js'

describe('parseClientMessage', () => {
  describe('valid messages', () => {
    it('parses identify message', () => {
      const result = parseClientMessage('{"type":"identify","id":"aaron"}')
      expect(result).toEqual({ type: 'identify', id: 'aaron' })
    })

    it('parses status message (onCall=true, muted=false)', () => {
      const result = parseClientMessage('{"type":"status","onCall":true,"muted":false}')
      expect(result).toEqual({ type: 'status', onCall: true, muted: false })
    })

    it('parses status message (onCall=false, muted=true)', () => {
      const result = parseClientMessage('{"type":"status","onCall":false,"muted":true}')
      expect(result).toEqual({ type: 'status', onCall: false, muted: true })
    })

    it('parses ping message', () => {
      const result = parseClientMessage('{"type":"ping"}')
      expect(result).toEqual({ type: 'ping' })
    })

    it('strips extra fields from ping', () => {
      const result = parseClientMessage('{"type":"ping","extra":"stuff"}')
      expect(result).toEqual({ type: 'ping' })
    })

    it('strips extra fields from identify', () => {
      const result = parseClientMessage('{"type":"identify","id":"aaron","extra":"stuff"}')
      expect(result).toEqual({ type: 'identify', id: 'aaron' })
    })

    it('strips extra fields from status', () => {
      const result = parseClientMessage('{"type":"status","onCall":true,"muted":false,"extra":"stuff"}')
      expect(result).toEqual({ type: 'status', onCall: true, muted: false })
    })
  })

  describe('invalid messages', () => {
    it('returns null for empty string', () => {
      expect(parseClientMessage('')).toBeNull()
    })

    it('returns null for non-JSON string', () => {
      expect(parseClientMessage('not json')).toBeNull()
    })

    it('returns null for JSON null', () => {
      expect(parseClientMessage('null')).toBeNull()
    })

    it('returns null for JSON string primitive', () => {
      expect(parseClientMessage('"a string"')).toBeNull()
    })

    it('returns null for JSON number primitive', () => {
      expect(parseClientMessage('123')).toBeNull()
    })

    it('returns null for JSON array', () => {
      expect(parseClientMessage('[]')).toBeNull()
    })

    it('returns null for object without type', () => {
      expect(parseClientMessage('{"id":"aaron"}')).toBeNull()
    })

    it('returns null for unknown type', () => {
      expect(parseClientMessage('{"type":"unknown"}')).toBeNull()
    })

    it('returns null for identify without id', () => {
      expect(parseClientMessage('{"type":"identify"}')).toBeNull()
    })

    it('returns null for identify with empty id', () => {
      expect(parseClientMessage('{"type":"identify","id":""}')).toBeNull()
    })

    it('returns null for identify with non-string id', () => {
      expect(parseClientMessage('{"type":"identify","id":123}')).toBeNull()
    })

    it('returns null for status without onCall', () => {
      expect(parseClientMessage('{"type":"status","muted":true}')).toBeNull()
    })

    it('returns null for status without muted', () => {
      expect(parseClientMessage('{"type":"status","onCall":true}')).toBeNull()
    })

    it('returns null for status with non-boolean muted', () => {
      expect(parseClientMessage('{"type":"status","onCall":true,"muted":"yes"}')).toBeNull()
    })

    it('returns null for status with non-boolean onCall', () => {
      expect(parseClientMessage('{"type":"status","onCall":"yes","muted":false}')).toBeNull()
    })
  })
})
