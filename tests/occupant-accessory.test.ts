import type { PlatformAccessory } from 'homebridge'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OccupantAccessory } from '../src/occupant-accessory.js'
import type { OnAirPlatform } from '../src/platform.js'

const OCCUPANCY_DETECTED = 1
const OCCUPANCY_NOT_DETECTED = 0

function createMockService() {
  return {
    setCharacteristic: vi.fn().mockReturnThis(),
    updateCharacteristic: vi.fn().mockReturnThis(),
  }
}

function createMocks(occupantId = 'aaron') {
  const infoService = createMockService()
  const onCallService = createMockService()
  const onAirService = createMockService()

  const mockAccessory = {
    getService: vi.fn().mockReturnValue(infoService),
    getServiceById: vi.fn((_type: string, _subtype: string): ReturnType<typeof createMockService> | null => {
      // Simulate services not yet existing — force addService path
      return null
    }),
    addService: vi.fn((type: string, name: string, subtype: string) => {
      if (subtype === `oncall-${occupantId}`) return onCallService
      if (subtype === `onair-${occupantId}`) return onAirService
      return createMockService()
    }),
  }

  const OccupancyDetected = Object.assign('OccupancyDetected', {
    OCCUPANCY_DETECTED,
    OCCUPANCY_NOT_DETECTED,
  })

  const mockPlatform = {
    Service: {
      AccessoryInformation: 'AccessoryInformation',
      OccupancySensor: 'OccupancySensor',
    },
    Characteristic: {
      Manufacturer: 'Manufacturer',
      Model: 'Model',
      SerialNumber: 'SerialNumber',
      OccupancyDetected,
    },
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  } as unknown as OnAirPlatform

  return { mockPlatform, mockAccessory, infoService, onCallService, onAirService, OccupancyDetected }
}

describe('OccupantAccessory', () => {
  describe('constructor', () => {
    it('sets accessory information characteristics', () => {
      const { mockPlatform, mockAccessory, infoService } = createMocks()
      new OccupantAccessory(mockPlatform, mockAccessory as unknown as PlatformAccessory, { id: 'aaron', displayName: 'Aaron' })

      expect(mockAccessory.getService).toHaveBeenCalledWith('AccessoryInformation')
      expect(infoService.setCharacteristic).toHaveBeenCalledWith('Manufacturer', 'homebridge-onair')
      expect(infoService.setCharacteristic).toHaveBeenCalledWith('Model', 'Occupant Sensor')
      expect(infoService.setCharacteristic).toHaveBeenCalledWith('SerialNumber', 'aaron')
    })

    it('creates on-call service with correct subtype', () => {
      const { mockPlatform, mockAccessory } = createMocks()
      new OccupantAccessory(mockPlatform, mockAccessory as unknown as PlatformAccessory, { id: 'aaron', displayName: 'Aaron' })

      expect(mockAccessory.getServiceById).toHaveBeenCalledWith('OccupancySensor', 'oncall-aaron')
      expect(mockAccessory.addService).toHaveBeenCalledWith('OccupancySensor', 'Aaron On Call', 'oncall-aaron')
    })

    it('creates on-air service with correct subtype', () => {
      const { mockPlatform, mockAccessory } = createMocks()
      new OccupantAccessory(mockPlatform, mockAccessory as unknown as PlatformAccessory, { id: 'aaron', displayName: 'Aaron' })

      expect(mockAccessory.getServiceById).toHaveBeenCalledWith('OccupancySensor', 'onair-aaron')
      expect(mockAccessory.addService).toHaveBeenCalledWith('OccupancySensor', 'Aaron On Air', 'onair-aaron')
    })

    it('reuses existing services when getServiceById returns them', () => {
      const existingOnCall = createMockService()
      const existingOnAir = createMockService()

      const { mockPlatform, mockAccessory } = createMocks()
      mockAccessory.getServiceById.mockImplementation((type: string, subtype: string) => {
        if (subtype === 'oncall-aaron') return existingOnCall
        if (subtype === 'onair-aaron') return existingOnAir
        return null
      })

      new OccupantAccessory(mockPlatform, mockAccessory as unknown as PlatformAccessory, { id: 'aaron', displayName: 'Aaron' })

      // addService should NOT be called since getServiceById found existing services
      expect(mockAccessory.addService).not.toHaveBeenCalled()
      // But existing services should have updateCharacteristic called (from clearState in constructor)
      expect(existingOnCall.updateCharacteristic).toHaveBeenCalled()
      expect(existingOnAir.updateCharacteristic).toHaveBeenCalled()
    })

    it('initializes both sensors to NOT_DETECTED via clearState()', () => {
      const { mockPlatform, mockAccessory, onCallService, onAirService, OccupancyDetected } = createMocks()
      new OccupantAccessory(mockPlatform, mockAccessory as unknown as PlatformAccessory, { id: 'aaron', displayName: 'Aaron' })

      // Constructor calls clearState(), setting both to NOT_DETECTED
      expect(onCallService.updateCharacteristic).toHaveBeenCalledWith(OccupancyDetected, OCCUPANCY_NOT_DETECTED)
      expect(onAirService.updateCharacteristic).toHaveBeenCalledWith(OccupancyDetected, OCCUPANCY_NOT_DETECTED)
    })

    it('handles getService returning undefined for AccessoryInformation', () => {
      const { mockPlatform, mockAccessory } = createMocks()
      mockAccessory.getService.mockReturnValue(undefined)

      // Should not throw
      expect(() => {
        new OccupantAccessory(mockPlatform, mockAccessory as unknown as PlatformAccessory, { id: 'aaron', displayName: 'Aaron' })
      }).not.toThrow()
    })
  })

  describe('updateState', () => {
    let onCallService: ReturnType<typeof createMockService>
    let onAirService: ReturnType<typeof createMockService>
    let OccupancyDetected: ReturnType<typeof createMocks>['OccupancyDetected']
    let accessoryInstance: OccupantAccessory

    beforeEach(() => {
      const mocks = createMocks()
      onCallService = mocks.onCallService
      onAirService = mocks.onAirService
      OccupancyDetected = mocks.OccupancyDetected
      accessoryInstance = new OccupantAccessory(mocks.mockPlatform, mocks.mockAccessory as unknown as PlatformAccessory, { id: 'aaron', displayName: 'Aaron' })

      // Clear mock call history from constructor
      onCallService.updateCharacteristic.mockClear()
      onAirService.updateCharacteristic.mockClear()
    })

    it('sets both to NOT_DETECTED when not on call (onCall=false, muted=false)', () => {
      accessoryInstance.updateState(false, false)

      expect(onCallService.updateCharacteristic).toHaveBeenCalledWith(OccupancyDetected, OCCUPANCY_NOT_DETECTED)
      expect(onAirService.updateCharacteristic).toHaveBeenCalledWith(OccupancyDetected, OCCUPANCY_NOT_DETECTED)
    })

    it('sets both to NOT_DETECTED when not on call even if muted (onCall=false, muted=true)', () => {
      accessoryInstance.updateState(false, true)

      expect(onCallService.updateCharacteristic).toHaveBeenCalledWith(OccupancyDetected, OCCUPANCY_NOT_DETECTED)
      expect(onAirService.updateCharacteristic).toHaveBeenCalledWith(OccupancyDetected, OCCUPANCY_NOT_DETECTED)
    })

    it('sets OnCall=DETECTED, OnAir=NOT_DETECTED when on call and muted', () => {
      accessoryInstance.updateState(true, true)

      expect(onCallService.updateCharacteristic).toHaveBeenCalledWith(OccupancyDetected, OCCUPANCY_DETECTED)
      expect(onAirService.updateCharacteristic).toHaveBeenCalledWith(OccupancyDetected, OCCUPANCY_NOT_DETECTED)
    })

    it('sets both to DETECTED when on call and unmuted', () => {
      accessoryInstance.updateState(true, false)

      expect(onCallService.updateCharacteristic).toHaveBeenCalledWith(OccupancyDetected, OCCUPANCY_DETECTED)
      expect(onAirService.updateCharacteristic).toHaveBeenCalledWith(OccupancyDetected, OCCUPANCY_DETECTED)
    })
  })

  describe('clearState', () => {
    it('sets both sensors to NOT_DETECTED', () => {
      const { mockPlatform, mockAccessory, onCallService, onAirService, OccupancyDetected } = createMocks()
      const accessoryInstance = new OccupantAccessory(mockPlatform, mockAccessory as unknown as PlatformAccessory, { id: 'aaron', displayName: 'Aaron' })

      // Set a state first
      onCallService.updateCharacteristic.mockClear()
      onAirService.updateCharacteristic.mockClear()

      accessoryInstance.clearState()

      expect(onCallService.updateCharacteristic).toHaveBeenCalledWith(OccupancyDetected, OCCUPANCY_NOT_DETECTED)
      expect(onAirService.updateCharacteristic).toHaveBeenCalledWith(OccupancyDetected, OCCUPANCY_NOT_DETECTED)
    })
  })

  describe('state transitions', () => {
    it('handles full call lifecycle: idle → on call → muted → unmuted → ended', () => {
      const { mockPlatform, mockAccessory, onCallService, onAirService, OccupancyDetected } = createMocks()
      const accessoryInstance = new OccupantAccessory(mockPlatform, mockAccessory as unknown as PlatformAccessory, { id: 'aaron', displayName: 'Aaron' })
      onCallService.updateCharacteristic.mockClear()
      onAirService.updateCharacteristic.mockClear()

      // Start on call, unmuted
      accessoryInstance.updateState(true, false)
      expect(onCallService.updateCharacteristic).toHaveBeenLastCalledWith(OccupancyDetected, OCCUPANCY_DETECTED)
      expect(onAirService.updateCharacteristic).toHaveBeenLastCalledWith(OccupancyDetected, OCCUPANCY_DETECTED)

      // Mute
      accessoryInstance.updateState(true, true)
      expect(onCallService.updateCharacteristic).toHaveBeenLastCalledWith(OccupancyDetected, OCCUPANCY_DETECTED)
      expect(onAirService.updateCharacteristic).toHaveBeenLastCalledWith(OccupancyDetected, OCCUPANCY_NOT_DETECTED)

      // Unmute
      accessoryInstance.updateState(true, false)
      expect(onCallService.updateCharacteristic).toHaveBeenLastCalledWith(OccupancyDetected, OCCUPANCY_DETECTED)
      expect(onAirService.updateCharacteristic).toHaveBeenLastCalledWith(OccupancyDetected, OCCUPANCY_DETECTED)

      // End call
      accessoryInstance.clearState()
      expect(onCallService.updateCharacteristic).toHaveBeenLastCalledWith(OccupancyDetected, OCCUPANCY_NOT_DETECTED)
      expect(onAirService.updateCharacteristic).toHaveBeenLastCalledWith(OccupancyDetected, OCCUPANCY_NOT_DETECTED)
    })
  })
})
