import { act, cleanup, render, screen } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createPluginContext } from '@/contrib/plugin'
import { BACKDROP_AREA } from '@/sdk/areas'
import { setPluginBackdropsEnabled } from '@/store/plugin-backdrops'
import * as windows from '@/store/windows'

import { BackdropLayer } from './backdrop-layer'

const disposers: Array<() => void> = []
const ctx = createPluginContext('backdrop-test')

afterEach(() => {
  cleanup()
  disposers.splice(0).forEach(dispose => dispose())
  setPluginBackdropsEnabled(true)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  window.history.replaceState({}, '', '/')
})

describe('BackdropLayer', () => {
  it('mounts the latest enabled contribution and restores the host on disposal', () => {
    const { container } = render(<BackdropLayer />)
    const bodyChildren = [...document.body.children]

    act(() => {
      disposers.push(
        ctx.register({
          area: BACKDROP_AREA,
          id: 'first',
          order: 100,
          render: () => <div>first</div>
        })
      )
    })
    const layer = container.querySelector('[data-plugin-backdrop]') as HTMLElement
    expect(screen.getByText('first')).toBeTruthy()
    expect(layer.style.pointerEvents).toBe('none')
    expect(layer.getAttribute('aria-hidden')).toBe('true')
    expect(layer.hasAttribute('inert')).toBe(true)
    expect(document.documentElement.hasAttribute('data-hermes-plugin-backdrop')).toBe(true)
    expect([...document.body.children]).toEqual(bodyChildren)

    act(() => {
      disposers.push(ctx.register({ area: BACKDROP_AREA, id: 'second', order: -100, render: () => <div>second</div> }))
    })
    expect(screen.queryByText('first')).toBeNull()
    expect(screen.getByText('second')).toBeTruthy()
    act(() => disposers.pop()?.())
    expect(screen.getByText('first')).toBeTruthy()
    act(() => disposers.pop()?.())
    expect(container.querySelector('[data-plugin-backdrop]')).toBeNull()
    expect(document.documentElement.hasAttribute('data-hermes-plugin-backdrop')).toBe(false)
    expect(document.documentElement.style.getPropertyValue('--plugin-backdrop-dim')).toBe('')
  })

  it('clamps the backdrop and surface opacity', () => {
    const { container } = render(<BackdropLayer />)
    act(() => {
      disposers.push(
        ctx.register({
          area: BACKDROP_AREA,
          id: 'clamped',
          data: { opacity: 2, dimApp: -1 },
          render: () => <div>scene</div>
        })
      )
    })
    expect((container.querySelector('[data-plugin-backdrop]') as HTMLElement).style.opacity).toBe('1')
    expect(document.documentElement.style.getPropertyValue('--plugin-backdrop-dim')).toBe('55%')
  })

  it('honors the setting and contains a failing contribution', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    setPluginBackdropsEnabled(false)
    const { container } = render(<BackdropLayer />)
    act(() => {
      disposers.push(
        ctx.register({
          area: BACKDROP_AREA,
          id: 'broken',
          render: () => {
            throw new Error('broken')
          }
        })
      )
    })
    expect(container.querySelector('[data-plugin-backdrop]')).toBeNull()
    expect(document.documentElement.hasAttribute('data-hermes-plugin-backdrop')).toBe(false)
    act(() => setPluginBackdropsEnabled(true))
    expect(container.querySelector('[data-plugin-backdrop]')).toBeNull()
    expect(document.documentElement.hasAttribute('data-hermes-plugin-backdrop')).toBe(false)
  })

  it.each(['?win=secondary', '?win=hud', '?win=browser', '?watch=1', '?peer=1'])(
    'does not mount in %s',
    async search => {
      window.history.replaceState({}, '', `/${search}`)
      vi.resetModules()
      const freshWindows = await import('@/store/windows')
      vi.spyOn(windows, 'isMainWindow').mockReturnValue(freshWindows.isMainWindow())
      disposers.push(ctx.register({ area: BACKDROP_AREA, id: 'window', render: () => <div>scene</div> }))
      render(<BackdropLayer />)
      expect(screen.queryByText('scene')).toBeNull()
      expect(document.documentElement.hasAttribute('data-hermes-plugin-backdrop')).toBe(false)
    }
  )

  it('unmounts when reduced transparency changes and restores on reversal', () => {
    let reduced = false
    const listeners = new Set<() => void>()
    vi.stubGlobal('matchMedia', () => ({
      get matches() {
        return reduced
      },
      addEventListener: (_: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => listeners.delete(listener)
    }))
    const unmount = vi.fn()

    function Scene() {
      useEffect(() => unmount, [])

      return <div>scene</div>
    }

    disposers.push(ctx.register({ area: BACKDROP_AREA, id: 'reduced', render: Scene }))
    render(<BackdropLayer />)
    expect(screen.getByText('scene')).toBeTruthy()
    act(() => {
      reduced = true
      listeners.forEach(listener => listener())
    })
    expect(screen.queryByText('scene')).toBeNull()
    expect(unmount).toHaveBeenCalledOnce()
    expect(document.documentElement.hasAttribute('data-hermes-plugin-backdrop')).toBe(false)
    act(() => {
      reduced = false
      listeners.forEach(listener => listener())
    })
    expect(screen.getByText('scene')).toBeTruthy()
  })

  it('skips entries without render and recovers when the same id is replaced', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(<BackdropLayer />)
    act(() => {
      disposers.push(ctx.register({ area: BACKDROP_AREA, id: 'valid', render: () => <div>valid</div> }))
    })
    act(() => {
      disposers.push(ctx.register({ area: BACKDROP_AREA, id: 'missing' }))
    })
    expect(screen.getByText('valid')).toBeTruthy()
    act(() => {
      disposers.push(
        ctx.register({
          area: BACKDROP_AREA,
          id: 'broken',
          render: () => {
            throw new Error('broken')
          }
        })
      )
    })
    expect(screen.queryByText('valid')).toBeNull()
    act(() => {
      disposers.push(ctx.register({ area: BACKDROP_AREA, id: 'broken', render: () => <div>fixed</div> }))
    })
    expect(screen.getByText('fixed')).toBeTruthy()
  })

  it('cleans up after a child effect throws and falls back for non-finite values', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    function Broken() {
      useEffect(() => {
        throw new Error('effect')
      }, [])

      return null
    }

    const { container } = render(<BackdropLayer />)
    act(() => {
      disposers.push(
        ctx.register({
          area: BACKDROP_AREA,
          id: 'nan',
          data: { opacity: NaN, dimApp: NaN },
          render: () => <div>scene</div>
        })
      )
    })
    expect((container.querySelector('[data-plugin-backdrop]') as HTMLElement).style.opacity).toBe('1')
    expect(document.documentElement.style.getPropertyValue('--plugin-backdrop-dim')).toBe('75%')
    act(() => {
      disposers.push(ctx.register({ area: BACKDROP_AREA, id: 'effect', render: Broken }))
    })
    expect(document.documentElement.hasAttribute('data-hermes-plugin-backdrop')).toBe(false)
    expect(document.documentElement.style.getPropertyValue('--plugin-backdrop-dim')).toBe('')
  })
})
