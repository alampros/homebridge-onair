import { describe, expect, it } from 'vitest'
import { DEFAULT_PORT, PLATFORM_NAME, PLUGIN_NAME } from '../src/settings.js'

describe('settings', () => {
  it('PLUGIN_NAME is homebridge-onair', () => {
    expect(PLUGIN_NAME).toBe('homebridge-onair')
  })

  it('PLATFORM_NAME is OnAir', () => {
    expect(PLATFORM_NAME).toBe('OnAir')
  })

  it('DEFAULT_PORT is 18440', () => {
    expect(DEFAULT_PORT).toBe(18440)
  })
})
