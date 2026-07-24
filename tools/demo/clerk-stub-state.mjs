// ACBP-P1-015 — the mutable session the Slice A demo's provider stub reads. Dev/CI only.
//
// The demo signs in as different users during the journey; the stub module needs a place to read the current
// provider user id from. Kept in its own module so both the loader-installed stub and the demo script resolve
// the SAME instance.
let providerUserId = '';

export function setSession(id) {
  providerUserId = id;
}

export function currentSession() {
  return providerUserId;
}
