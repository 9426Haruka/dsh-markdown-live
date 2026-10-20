/**
 * Host half of the dsh-markdown-live bundle.
 *
 * The plugin is purely browser-side: the composer live renderer, the user
 * message Markdown renderer and every stylesheet live in client.js. This
 * host module exists so the bundle owns one Loader row (visible in
 * Settings → Plugins) and can be toggled without touching the profile.
 */
export function apply() {}
