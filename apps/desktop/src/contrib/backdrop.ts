import { atom } from 'nanostores'

import type { Contribution } from './types'

/** One full-window layer behind the app. The latest enabled contribution wins;
 *  it is click-through, never takes focus, and stops painting on disposal (the
 *  layer falls back to the newest remaining registration, if any). */
export const BACKDROP_AREA = 'backdrop'

/** The backdrop's optional payload. `opacity` fades the scene itself;
 *  `appOpacity` is how much of the app's shell stays in front of it. */
export interface PluginBackdropData {
  opacity?: number
  appOpacity?: number
}

/** Bumped on every backdrop registration. The layer keys its error boundary by
 *  it, so a re-registration starts a fresh scene instead of inheriting the
 *  previous one's failure. */
export const $backdropSequence = atom(0)

const registrations = new WeakMap<Contribution, number>()

export function recordBackdropRegistration(contribution: Contribution): void {
  const sequence = $backdropSequence.get() + 1

  registrations.set(contribution, sequence)
  $backdropSequence.set(sequence)
}

export function latestBackdrop(items: readonly Contribution[]): Contribution | undefined {
  let latest: Contribution | undefined
  let latestSequence = -1

  for (const item of items) {
    const registered = registrations.get(item) ?? 0

    // A truthy non-function `render` (an untyped JS plugin) is not renderable:
    // skipping it keeps the previous valid backdrop on screen.
    if (typeof item.render === 'function' && registered > latestSequence) {
      latest = item
      latestSequence = registered
    }
  }

  return latest
}
