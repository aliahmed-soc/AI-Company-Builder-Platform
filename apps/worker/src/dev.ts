// @acbp/worker — local dev entry (ACBP-P0-021).
//
// The worker app is a scaffold: no job consumption, workflow execution, or tool dispatch exists yet
// (they arrive in later phases). Rather than fake a running worker, this prints an honest notice and
// exits 0. When apps/worker gains a real entry point, this command will start it. Do NOT add product
// behavior here.
console.log('[@acbp/worker] scaffold entry — no worker loop implemented yet (Phase 0). Nothing to run.');
console.log('This dev command will start the real worker process once apps/worker is implemented in a later ticket.');
