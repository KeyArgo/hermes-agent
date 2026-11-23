import { afterEach, describe, expect, it } from 'vitest'

import { storedBoolean } from '@/lib/storage'

import { $pluginBackdropsEnabled, setPluginBackdropsEnabled } from './plugin-backdrops'

const KEY = 'hermes.desktop.plugin-backdrops.v1'

afterEach(() => {
  setPluginBackdropsEnabled(false)
})

describe('plugin backdrop setting', () => {
  // The atom loads with what a first launch has: no stored key. A backdrop is
  // app-wide scenery a plugin asked for, so the default answers "not yet" —
  // an unasked-for full-window render is the wrong thing to opt a user into.
  it('is off by default, so a fresh store paints nothing until the user allows it', () => {
    expect($pluginBackdropsEnabled.get()).toBe(false)
  })

  it('persists the choice the user makes', () => {
    setPluginBackdropsEnabled(true)
    expect($pluginBackdropsEnabled.get()).toBe(true)
    expect(storedBoolean(KEY, false)).toBe(true)

    setPluginBackdropsEnabled(false)
    expect($pluginBackdropsEnabled.get()).toBe(false)
    expect(storedBoolean(KEY, true)).toBe(false)
  })
})
