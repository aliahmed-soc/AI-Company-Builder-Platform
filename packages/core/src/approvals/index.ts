// core/approvals — module public index (ACBP-P6-003c; CDR-068). Cross-module imports go through this index
// (spec rule 10).
//
// NOTE FOR `tools/check-approval-port.mjs`: this module ceasing to be a scaffold is one of the two signals that an
// approval store now exists, which is what turns the caller-injectable `ToolGates.approval` port from a seam into a
// bypass. The port is closed in the same ticket that added these exports; if that check ever fires again, the fix is
// to close the port, never to weaken the check.
export { requestApproval, decideApproval, listApprovalInbox } from './approval-service.js';
export type {
  ApprovalServiceOptions,
  RequestApprovalParams,
  RequestApprovalResult,
  DecideApprovalParams,
  DecideApprovalResult,
  ListApprovalInboxParams,
  ListApprovalInboxResult,
} from './approval-service.js';
