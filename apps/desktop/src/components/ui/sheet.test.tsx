import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from './sheet'

afterEach(() => {
  cleanup()
  window.document.documentElement.removeAttribute('data-hermes-plugin-backdrop')
})

describe('SheetContent under a plugin backdrop', () => {
  it('masks the scene instead of painting the cleared field token', () => {
    // A sheet portals to <body>, outside the shell that paints the app dim, and
    // it paints with --ui-sidebar-surface-background — cleared while a backdrop
    // is mounted. Without `data-glass-opaque` its text sits on the 22% scrim
    // over the scene. Contract: `[data-glass-opaque]` in styles.css.
    window.document.documentElement.setAttribute('data-hermes-plugin-backdrop', '')
    render(
      <Sheet open>
        <SheetContent side="bottom">
          <SheetHeader>
            <SheetTitle>Language</SheetTitle>
            <SheetDescription>Pick a language</SheetDescription>
          </SheetHeader>
        </SheetContent>
      </Sheet>
    )

    const sheet = window.document.querySelector('[data-slot="sheet-content"]')

    expect(sheet).toBeTruthy()
    expect(sheet?.hasAttribute('data-glass-opaque')).toBe(true)
  })
})
