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

  it('follows a flip made in another window, and treats removal as the default', () => {
    setPluginBackdropsEnabled(false)

    // Another window writes the shared key; this window only sees the event.
    window.localStorage.setItem(KEY, 'true')
    window.dispatchEvent(new StorageEvent('storage', { key: KEY, newValue: 'true' }))
    expect($pluginBackdropsEnabled.get()).toBe(true)

    window.localStorage.setItem(KEY, 'false')
    window.dispatchEvent(new StorageEvent('storage', { key: KEY, newValue: 'false' }))
    expect($pluginBackdropsEnabled.get()).toBe(false)

    window.localStorage.setItem(KEY, 'true')
    window.dispatchEvent(new StorageEvent('storage', { key: KEY, newValue: 'true' }))
    window.localStorage.removeItem(KEY)
    window.dispatchEvent(new StorageEvent('storage', { key: KEY, newValue: null }))
    expect($pluginBackdropsEnabled.get()).toBe(false)
  })

  it('ignores events for other keys', () => {
    setPluginBackdropsEnabled(false)
    window.localStorage.setItem(KEY, 'true')
    window.dispatchEvent(new StorageEvent('storage', { key: 'hermes.desktop.other', newValue: 'true' }))
    expect($pluginBackdropsEnabled.get()).toBe(false)
    window.localStorage.removeItem(KEY)
  })
})
