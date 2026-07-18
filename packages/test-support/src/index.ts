// @acbp/test-support — shared test helpers (dev/CI only; never a production dependency).
// Kept intentionally minimal (ACBP-P0-014); real shared fixtures/fakes are added by the
// tickets that need them. See docs/implementation/TESTING.md §"Shared test support".
export const TEST_MARKER = 'acbp-test-support' as const;

