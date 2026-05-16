import type { PlatformAccessory, Service } from 'homebridge'

import type { OnAirPlatform } from './platform.js'

export class OccupantAccessory {
  private readonly onCallService: Service
  private readonly onAirService: Service

  constructor(
    private readonly platform: OnAirPlatform,
    readonly accessory: PlatformAccessory,
    readonly occupant: { id: string; displayName: string },
  ) {
    this.platform.log.debug('[accessory] Initializing occupant "%s" (%s)', occupant.displayName, occupant.id)

    // Set accessory information
    accessory
      .getService(this.platform.Service.AccessoryInformation)
      ?.setCharacteristic(this.platform.Characteristic.Manufacturer, 'homebridge-onair')
      .setCharacteristic(this.platform.Characteristic.Model, 'Occupant Sensor')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, occupant.id)

    // Get or create the "On Call" OccupancySensor service (with subtype for disambiguation)
    this.onCallService =
      accessory.getServiceById(this.platform.Service.OccupancySensor, `oncall-${occupant.id}`) ||
      accessory.addService(this.platform.Service.OccupancySensor, `${occupant.displayName} On Call`, `oncall-${occupant.id}`)

    // Get or create the "On Air" OccupancySensor service (with subtype for disambiguation)
    this.onAirService =
      accessory.getServiceById(this.platform.Service.OccupancySensor, `onair-${occupant.id}`) ||
      accessory.addService(this.platform.Service.OccupancySensor, `${occupant.displayName} On Air`, `onair-${occupant.id}`)

    // Initialize both sensors to NOT_DETECTED
    this.clearState()
  }

  /**
   * Update sensor state based on call status.
   *
   * | onCall | muted | OnCall Sensor | OnAir Sensor |
   * |--------|-------|---------------|--------------|
   * | false  | n/a   | NOT_DETECTED  | NOT_DETECTED |
   * | true   | true  | DETECTED      | NOT_DETECTED |
   * | true   | false | DETECTED      | DETECTED     |
   */
  updateState(onCall: boolean, muted: boolean): void {
    const { OccupancyDetected } = this.platform.Characteristic

    if (!onCall) {
      this.platform.log.debug('[accessory] "%s" state: not on call → OnCall=NOT_DETECTED, OnAir=NOT_DETECTED', this.occupant.displayName)
      this.onCallService.updateCharacteristic(OccupancyDetected, OccupancyDetected.OCCUPANCY_NOT_DETECTED)
      this.onAirService.updateCharacteristic(OccupancyDetected, OccupancyDetected.OCCUPANCY_NOT_DETECTED)
    } else if (muted) {
      this.platform.log.debug('[accessory] "%s" state: on call (muted) → OnCall=DETECTED, OnAir=NOT_DETECTED', this.occupant.displayName)
      this.onCallService.updateCharacteristic(OccupancyDetected, OccupancyDetected.OCCUPANCY_DETECTED)
      this.onAirService.updateCharacteristic(OccupancyDetected, OccupancyDetected.OCCUPANCY_NOT_DETECTED)
    } else {
      this.platform.log.debug('[accessory] "%s" state: on call (unmuted) → OnCall=DETECTED, OnAir=DETECTED', this.occupant.displayName)
      this.onCallService.updateCharacteristic(OccupancyDetected, OccupancyDetected.OCCUPANCY_DETECTED)
      this.onAirService.updateCharacteristic(OccupancyDetected, OccupancyDetected.OCCUPANCY_DETECTED)
    }
  }

  /** Set both sensors to NOT_DETECTED. */
  clearState(): void {
    this.platform.log.debug('[accessory] "%s" clearing state → OnCall=NOT_DETECTED, OnAir=NOT_DETECTED', this.occupant.displayName)
    const { OccupancyDetected } = this.platform.Characteristic

    this.onCallService.updateCharacteristic(OccupancyDetected, OccupancyDetected.OCCUPANCY_NOT_DETECTED)
    this.onAirService.updateCharacteristic(OccupancyDetected, OccupancyDetected.OCCUPANCY_NOT_DETECTED)
  }
}
