// Node-side stand-in for @cloudflare/playwright (which only runs inside workerd).
// Unit tests exercise adapter routing and parsing, never a real browser.
export function launch(): never {
  throw new Error("Browser Rendering is not available in unit tests");
}
export type Page = never;
export type Locator = never;
