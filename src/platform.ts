import type { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service } from 'homebridge'
import { OccupantAccessory } from './occupant-accessory.js'
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js'
import { OnAirServer } from './ws-server.js'

export class OnAirPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service
  public readonly Characteristic: typeof Characteristic

  /** Cached accessories restored by Homebridge on startup, keyed by UUID. */
  public readonly accessories = new Map<string, PlatformAccessory>()

  /** Wrapped OccupantAccessory instances, keyed by occupant ID. */
  public readonly occupantAccessories = new Map<string, OccupantAccessory>()

  /** WebSocket server for companion app connections. */
  public wsServer?: OnAirServer

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service
    this.Characteristic = api.hap.Characteristic

    this.log.info('OnAir platform initialized')

    this.api.on('didFinishLaunching', () => {
      this.discoverDevices()
      this.wsServer = new OnAirServer(this)
      this.wsServer.start().catch((err) => {
        this.log.error('Failed to start WebSocket server:', err)
      })
    })

    this.api.on('shutdown', () => {
      this.log.info('Shutting down OnAir platform...')

      // Clear all occupant sensor states
      for (const occupantAccessory of this.occupantAccessories.values()) {
        occupantAccessory.clearState()
      }

      // Stop WebSocket server (closes sockets, unadvertises mDNS, clears timers)
      if (this.wsServer) {
        this.wsServer.stop().catch((err: Error) => {
          this.log.error('Error during shutdown:', err.message)
        })
      }
    })
  }

  /**
   * Called by Homebridge for each cached accessory restored from disk.
   * This is invoked before `didFinishLaunching`.
   */
  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info('Restoring cached accessory:', accessory.displayName)
    this.accessories.set(accessory.UUID, accessory)
  }

  /**
   * Called after all cached accessories have been restored.
   * Creates or restores OccupantAccessory wrappers for each configured occupant,
   * and removes stale accessories that are no longer in the config.
   */
  discoverDevices(): void {
    const occupants: Array<{ id: string; displayName: string }> | undefined = this.config.occupants as Array<{ id: string; displayName: string }> | undefined

    if (!occupants || occupants.length === 0) {
      this.log.warn('No occupants configured — nothing to discover.')
      return
    }

    // Track which UUIDs are still in the current config
    const activeUUIDs = new Set<string>()

    for (const occupant of occupants) {
      const uuid = this.api.hap.uuid.generate(occupant.id)
      activeUUIDs.add(uuid)

      const existingAccessory = this.accessories.get(uuid)

      if (existingAccessory) {
        // Reuse the cached accessory
        this.log.info('Restoring existing accessory from cache:', occupant.displayName)
        existingAccessory.context.occupant = occupant
        const wrapped = new OccupantAccessory(this, existingAccessory, occupant)
        this.occupantAccessories.set(occupant.id, wrapped)
      } else {
        // Create a new accessory
        this.log.info('Adding new accessory:', occupant.displayName)
        const accessory = new this.api.platformAccessory(occupant.displayName, uuid)
        accessory.context.occupant = occupant
        const wrapped = new OccupantAccessory(this, accessory, occupant)
        this.occupantAccessories.set(occupant.id, wrapped)
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory])
      }
    }

    // Remove stale accessories that are no longer in the config
    for (const [uuid, accessory] of this.accessories) {
      if (!activeUUIDs.has(uuid)) {
        this.log.info('Removing stale accessory:', accessory.displayName)
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory])
        this.accessories.delete(uuid)
      }
    }
  }

  /**
   * Lookup an OccupantAccessory by occupant ID.
   * Used by the WebSocket server in Phase 3.
   */
  getOccupantAccessory(id: string): OccupantAccessory | undefined {
    return this.occupantAccessories.get(id)
  }
}
