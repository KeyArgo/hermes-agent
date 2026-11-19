import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { createPluginContext } from '@/contrib/plugin'
import { BACKDROP_AREA } from '@/sdk/areas'
import { setPluginBackdropsEnabled } from '@/store/plugin-backdrops'

import { BackdropLayer } from './backdrop-layer'

// The setting is off on a fresh store, and this file never turns it on up
// front: a registration alone must paint nothing. Kept apart from
// backdrop-layer.test.tsx, whose tests enable the setting to exercise a live
// backdrop.
const disposers: Array<() => void> = []
const ctx = createPluginContext('backdrop-off')

afterEach(() => {
  cleanup()
  disposers.splice(0).forEach(dispose => dispose())
  setPluginBackdropsEnabled(false)
})

describe('BackdropLayer before the user allows plugin backdrops', () => {
  it('paints nothing for a registration until the setting is enabled', () => {
    const { container } = render(<BackdropLayer />)
    act(() => {
      disposers.push(ctx.register({ area: BACKDROP_AREA, id: 'scene', render: () => <div>scene</div> }))
    })

    expect(screen.queryByText('scene')).toBeNull()
    expect(container.querySelector('[data-plugin-backdrop]')).toBeNull()
    expect(document.documentElement.hasAttribute('data-hermes-plugin-backdrop')).toBe(false)
    expect(document.documentElement.style.getPropertyValue('--plugin-backdrop-dim')).toBe('')

    // The registration was never consumed — enabling the setting is all it
    // takes for the same backdrop to appear.
    act(() => setPluginBackdropsEnabled(true))
    expect(screen.getByText('scene')).toBeTruthy()
    expect(document.documentElement.hasAttribute('data-hermes-plugin-backdrop')).toBe(true)
  })
})
