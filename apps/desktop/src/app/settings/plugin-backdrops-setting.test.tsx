// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { $interfaceMode } from '@/store/interface-mode'
import { $pluginBackdropsEnabled, setPluginBackdropsEnabled } from '@/store/plugin-backdrops'

import { AppearanceSettings } from './appearance-settings'

// A backdrop is full-window scenery a plugin asked for, so the opt-in belongs
// beside the other window-appearance toggles rather than in the plugin pages.

beforeEach(() => {
  act(() => {
    $interfaceMode.set('advanced')
    setPluginBackdropsEnabled(false)
  })
})

afterEach(() => {
  cleanup()
  act(() => setPluginBackdropsEnabled(false))
})

function pluginBackdropSwitch() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <AppearanceSettings subpage="window-layout" />
    </QueryClientProvider>
  )

  return screen.getByRole('switch', { name: 'Allow Plugin Backdrops' })
}

describe('plugin backdrops setting', () => {
  it('sits in Window Layout beside Chat Backdrop and toggles the store', () => {
    const toggle = pluginBackdropSwitch()

    // Same section as the chat backdrop toggle, not a plugin page of its own.
    expect(screen.getByRole('switch', { name: 'Chat Backdrop' })).toBeTruthy()
    expect(toggle.getAttribute('aria-checked')).toBe('false')

    fireEvent.click(toggle)

    expect($pluginBackdropsEnabled.get()).toBe(true)
    expect(toggle.getAttribute('aria-checked')).toBe('true')

    fireEvent.click(toggle)

    expect($pluginBackdropsEnabled.get()).toBe(false)
    expect(toggle.getAttribute('aria-checked')).toBe('false')
  })

  it('follows the store when another window flips it', () => {
    const toggle = pluginBackdropSwitch()

    act(() => setPluginBackdropsEnabled(true))

    expect(toggle.getAttribute('aria-checked')).toBe('true')
  })
})
