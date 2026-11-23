import { atom } from 'nanostores'

import { persistStore } from '@/lib/persist-store'
import { persistBoolean, storedBoolean } from '@/lib/storage'

const KEY = 'hermes.desktop.plugin-backdrops.v1'

// Off by default: a backdrop is full-window scenery a plugin asked for, and the
// app should not wear one until the person using it says so (Settings ▸
// Appearance). Every window reads this one key, so the choice is app-wide.
export const $pluginBackdropsEnabled = atom(storedBoolean(KEY, false))

persistStore($pluginBackdropsEnabled, (on, options) => persistBoolean(KEY, on, options), false)

export function setPluginBackdropsEnabled(on: boolean): void {
  $pluginBackdropsEnabled.set(on)
}
