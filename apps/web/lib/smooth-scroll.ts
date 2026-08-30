import type { LenisOptions } from "lenis";

/**
 * Lenis configuration for the marketing surface.
 *
 * ## Why the landing page needs a scroll driver at all
 *
 * `components/marketing/scene/core-scene.tsx` is a 420vh container with one
 * `ScrollTrigger.create({ scrub: true })` mapping native scroll position
 * straight onto scene progress. Native scroll is not continuous: a wheel notch
 * is a ~100px instantaneous jump and a trackpad flick is a much larger one, so
 * the scrub advances in discrete steps. Everything driven directly off progress
 * — the room plate's transform, the backdrop gradient, hero opacity, document
 * positions — snaps with it, while the camera (which `CameraRig` lerps toward
 * its scripted position) glides. That mismatch is what reads as the page
 * "flying" on the first scroll.
 *
 * Lenis fixes it at the input: it interpolates the real scroll position, GSAP's
 * ticker drives Lenis, and ScrollTrigger reads the smoothed result. Nothing in
 * `lib/scene-script.ts` changes — progress still arrives as a 0-1 float, so
 * every composition rule, projection test and contrast measurement holds.
 *
 * Kept pure and separate from `components/marketing/smooth-scroll.tsx` for the
 * same reason as every other module in here: the values below are decisions,
 * and two of them break the page rather than merely change its feel if they are
 * ever inverted. See `smooth-scroll.test.ts`.
 */
export function smoothScrollOptions(reducedMotion: boolean): LenisOptions {
  return {
    /**
     * GSAP's ticker drives `lenis.raf`, so Lenis must NOT run its own
     * `requestAnimationFrame` loop. Two loops advance the animation twice per
     * frame and desynchronise it from `ScrollTrigger.update`, which is wired to
     * the same ticker. `ReactLenis` defaults this to `true`.
     */
    autoRaf: false,

    /**
     * Lenis's own default. Roughly 10 frames to settle (~160ms) — clearly
     * smooth on the scrub without putting perceptible latency on the reading
     * sections below it (statement, platform tiles, pricing, FAQ, contact).
     *
     * This is the main feel knob. Lower is heavier and more cinematic; much
     * below 0.075 the FAQ starts to feel like it is resisting the wheel.
     */
    lerp: 0.1,
    wheelMultiplier: 1,

    /**
     * Reduced motion keeps the wheel native. Lenis is still instantiated (see
     * the component for why it is never conditionally mounted) but does no
     * interpolation, so scrolling behaves exactly as it did before this module
     * existed.
     */
    smoothWheel: !reducedMotion,

    /**
     * Touch stays on the browser's own momentum. `syncTouch` routes touch
     * through Lenis for an identical feel everywhere, at the cost of fighting
     * iOS's native inertia — the most common source of "laggy on mobile" with
     * this library. The 3D scene has still never been seen on a real phone
     * (see apps/web/CLAUDE.md's mobile section), so this change is deliberately
     * scoped to input devices that can be verified here.
     */
    syncTouch: false,

    /**
     * Lenis intercepts `<a href="#…">` clicks and animates to the target, which
     * is what lets every existing anchor on this page keep working with no
     * per-link change: `mk-nav.tsx`'s four links (desktop and the mobile
     * sheet), `faq.tsx` and `mk-footer.tsx`'s `#contact`, and the layout's
     * `#main` skip link.
     *
     * Under reduced motion it becomes an instant jump rather than an animated
     * one — the destination is the point, the travel is not.
     */
    anchors: reducedMotion ? { immediate: true } : true,
  };
}
