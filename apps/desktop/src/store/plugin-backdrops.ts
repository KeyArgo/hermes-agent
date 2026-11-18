import { atom } from 'nanostores'

import { persistStore } from '@/lib/persist-store'
import { persistBoolean, storedBoolean } from '@/lib/storage'

const KEY = 'hermes.desktop.plugin-backdrops.v1'

export const $pluginBackdropsEnabled = atom(storedBoolean(KEY, true))

persistStore($pluginBackdropsEnabled, (on, options) => persistBoolean(KEY, on, options), true)

export function setPluginBackdropsEnabled(on: boolean): void {
  $pluginBackdropsEnabled.set(on)
}
