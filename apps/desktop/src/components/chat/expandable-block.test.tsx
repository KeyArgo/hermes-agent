import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ExpandableBlock } from './expandable-block'

// jsdom has no ResizeObserver and reports scrollHeight === 0, so the block
// never flips to `overflowing` on its own. Stub RO to fire immediately and
// force a tall scrollHeight on the observed node so the toggle mounts.
class TestResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}

  observe(target: Element) {
    Object.defineProperty(target, 'scrollHeight', { configurable: true, value: 400 })
    Object.defineProperty(target, 'clientWidth', { configurable: true, value: 200 })
    Object.defineProperty(target, 'scrollWidth', { configurable: true, value: 400 })
    Object.defineProperty(target, 'scrollLeft', { configurable: true, writable: true, value: 0 })
    this.callback([{ target } as ResizeObserverEntry], this as unknown as ResizeObserver)
  }

  unobserve() {}
  disconnect() {}
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  delete window.document.documentElement.dataset.hermesDesktopHost
})

describe('ExpandableBlock', () => {
  it('still toggles expanded state when the compact control is clicked', () => {
    vi.stubGlobal('ResizeObserver', TestResizeObserver)

    render(
      <ExpandableBlock>
        <pre data-testid="content">{'line\n'.repeat(20)}</pre>
      </ExpandableBlock>
    )

    const toggle = screen.getByRole('button', { name: 'Expand' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(toggle)

    expect(screen.getByRole('button', { name: 'Collapse' }).getAttribute('aria-expanded')).toBe('true')
  })

  it('shows a non-blocking horizontal cue until a wide block reaches its end', () => {
    window.document.documentElement.dataset.hermesDesktopHost = 'browser'
    vi.stubGlobal('ResizeObserver', TestResizeObserver)

    render(
      <ExpandableBlock>
        <pre data-testid="content">{'wide line\n'.repeat(2)}</pre>
      </ExpandableBlock>
    )

    const scroller = screen.getByTestId('content').parentElement!

    expect(scroller.getAttribute('data-horizontal-overflow')).toBe('')
    expect(
      screen
        .getByTestId('content')
        .parentElement?.parentElement?.querySelector('[data-slot="expandable-horizontal-fade"]')
    ).not.toBeNull()

    scroller.scrollLeft = 200
    fireEvent.scroll(scroller)

    expect(
      screen
        .getByTestId('content')
        .parentElement?.parentElement?.querySelector('[data-slot="expandable-horizontal-fade"]')
    ).toBeNull()
  })

  // Native Desktop draws no sideways cue on a wide block, as on main.
  it('draws no horizontal cue on a wide block in native Desktop', () => {
    vi.stubGlobal('ResizeObserver', TestResizeObserver)

    render(
      <ExpandableBlock>
        <pre data-testid="content">{'wide line\n'.repeat(2)}</pre>
      </ExpandableBlock>
    )

    const block = screen.getByTestId('content').parentElement!

    expect(block.hasAttribute('data-horizontal-overflow')).toBe(false)
    expect(block.parentElement?.querySelector('[data-slot="expandable-horizontal-fade"]')).toBeNull()
  })

  it('keeps the overflow fades solid when the chat surface token is transparent', () => {
    window.document.documentElement.dataset.hermesDesktopHost = 'browser'
    vi.stubGlobal('ResizeObserver', TestResizeObserver)

    render(
      <ExpandableBlock>
        <pre data-testid="content">{'line\n'.repeat(20)}</pre>
      </ExpandableBlock>
    )

    // Under a plugin backdrop (or window glass) --ui-chat-surface-background
    // is transparent at :root, and a fade from transparent is no overflow cue
    // at all. Both fades mask the block's own content, so they scope the token
    // back to solid at the call site. Contract: `[data-glass-opaque]` in
    // styles.css.
    const horizontal = screen
      .getByTestId('content')
      .parentElement?.parentElement?.querySelector('[data-slot="expandable-horizontal-fade"]')

    const vertical = screen.getByRole('button', { name: 'Expand' }).parentElement

    expect(horizontal?.hasAttribute('data-glass-opaque')).toBe(true)
    expect(vertical?.hasAttribute('data-glass-opaque')).toBe(true)
  })
})
