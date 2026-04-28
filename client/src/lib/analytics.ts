/**
 * Beta-period instrumentation. PostHog with Anchor-specific defaults:
 *   - autocapture OFF (we hand-pick exactly which events matter)
 *   - session_recording masks all inputs (Anchor is local-first; we don't
 *     want to ship user keystrokes to a third party)
 *   - opt_out_capturing_by_default if VITE_POSTHOG_KEY is unset (graceful)
 *
 * Per PostHog 2026 best-practice (instrumentation hygiene):
 *   "If an event will not influence a roadmap, experiment, onboarding
 *   improvement, or KPI review, it probably should not exist."
 *
 * The 5 events here map to the 4 things SaaS-onboarding research says
 * to measure: signup completed, time-to-value (first message), engagement
 * (agent run + plugin install), return behavior (24h-return). That's it.
 *
 * Day-1 wiring is intentional minimum. Add events when (and ONLY when)
 * a specific decision needs the data.
 */
import posthog from "posthog-js";

const KEY = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
const HOST = (import.meta.env.VITE_POSTHOG_HOST as string | undefined) ?? "https://us.i.posthog.com";

let initialized = false;

export function initAnalytics(): void {
  if (initialized) return;
  initialized = true;

  if (!KEY) {
    // Graceful no-op in dev without a key. Keeps `track.X(...)` callable.
    if (import.meta.env.DEV) console.log("[analytics] VITE_POSTHOG_KEY not set — analytics disabled");
    return;
  }

  posthog.init(KEY, {
    api_host: HOST,
    autocapture: false,                 // hand-pick events
    capture_pageview: false,            // we route via wouter; pageviews aren't meaningful
    persistence: "localStorage+cookie",
    session_recording: {
      maskAllInputs: true,              // Anchor is local-first — never record keystrokes
      maskTextSelector: ".sensitive",   // any element with class="sensitive" is masked entirely
    },
    loaded: (ph) => {
      if (import.meta.env.DEV) ph.opt_out_capturing(); // dev sessions never report
    },
  });
}

/** Bind the current user. Call after refresh() resolves. */
export function identify(userId: string, email?: string): void {
  if (!KEY) return;
  posthog.identify(userId, email ? { email } : undefined);
}

/** Clear identity on logout. */
export function resetIdentity(): void {
  if (!KEY) return;
  posthog.reset();
}

/**
 * The 5 events. Add new ones ONLY when a specific roadmap/experiment
 * decision needs the data. See PostHog hygiene principle in module doc.
 */
export const track = {
  signup_completed:   () => posthog?.capture("signup_completed"),
  first_message_sent: () => posthog?.capture("first_message_sent"),       // time-to-value
  agent_run_started:  (agent: string) => posthog?.capture("agent_run_started", { agent }),
  plugin_installed:   (name: string) => posthog?.capture("plugin_installed", { name }),
  returned_after_24h: () => posthog?.capture("returned_after_24h"),       // return behavior
};
