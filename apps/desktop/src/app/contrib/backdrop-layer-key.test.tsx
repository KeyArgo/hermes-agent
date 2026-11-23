import { act, cleanup, render, screen } from '@testing-library/react'
import { StrictMode, useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createPluginContext } from '@/contrib/plugin'
import { BACKDROP_AREA } from '@/sdk/areas'
import { setPluginBackdropsEnabled } from '@/store/plugin-backdrops'

import { BackdropLayer } from './backdrop-layer'

// The boundary key is the reconciliation seam: it alone decides whether a
// re-registration resets the backdrop's error state, so it is asserted through
// the scene's own mount count — a remount means the boundary was replaced.
const disposers: Array<() => void> = []
const ctx = createPluginContext('backdrop-key')

// Off by default now; this file is about a mounted backdrop's error boundary.
beforeEach(() => {
  setPluginBackdropsEnabled(true)
})

afterEach(() => {
  cleanup()
  disposers.splice(0).forEach(dispose => dispose())
  vi.restoreAllMocks()
})

describe('BackdropLayer error-boundary key', () => {
  it('keeps the boundary across unrelated renders and resets it on re-registration', () => {
    const mounts = vi.fn()

    function Scene() {
      useEffect(() => {
        mounts()
      }, [])

      return <div>scene</div>
    }

    const { rerender } = render(
      <StrictMode>
        <BackdropLayer />
      </StrictMode>
    )

    act(() => {
      disposers.push(ctx.register({ area: BACKDROP_AREA, id: 'bg', render: Scene }))
    })

    const mounted = mounts.mock.calls.length
    expect(mounted).toBeGreaterThan(0)

    // Unrelated host re-renders keep the registration — and its boundary — so
    // the scene is not remounted and does not lose its state.
    rerender(
      <StrictMode>
        <BackdropLayer />
      </StrictMode>
    )
    rerender(
      <StrictMode>
        <BackdropLayer />
      </StrictMode>
    )
    expect(mounts.mock.calls.length).toBe(mounted)

    // Re-registering the same id is a NEW registration: a new key, so the
    // boundary (and any error state it holds) is reset and the scene remounts.
    act(() => {
      disposers.push(ctx.register({ area: BACKDROP_AREA, id: 'bg', render: Scene }))
    })
    expect(mounts.mock.calls.length).toBeGreaterThan(mounted)
  })

  it('resets a failed backdrop when the same id is re-registered', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    render(
      <StrictMode>
        <BackdropLayer />
      </StrictMode>
    )

    act(() => {
      disposers.push(
        ctx.register({
          area: BACKDROP_AREA,
          id: 'bg',
          render: () => {
            throw new Error('broken')
          }
        })
      )
    })
    expect(screen.queryByText('fixed')).toBeNull()
    expect(document.documentElement.hasAttribute('data-hermes-plugin-backdrop')).toBe(false)

    act(() => {
      disposers.push(ctx.register({ area: BACKDROP_AREA, id: 'bg', render: () => <div>fixed</div> }))
    })
    expect(screen.getByText('fixed')).toBeTruthy()
    expect(document.documentElement.hasAttribute('data-hermes-plugin-backdrop')).toBe(true)
  })
})
