// core/discovery — module public index (ACBP-P2-001; CDR-022). Cross-module imports go through this index
// (scaffold-spec rule 10). Interview session lifecycle use cases.
export {
  startInterviewSession,
  suspendInterviewSession,
  resumeInterviewSession,
  getInterviewSession,
  type InterviewSessionParams,
  type InterviewSessionOptions,
  type StartInterviewResult,
  type InterviewTransitionResult,
  type GetInterviewResult,
} from './interview-session.js';
export {
  addInterviewQuestion,
  recordInterviewAnswer,
  getSessionQa,
  type InterviewQaParams,
  type InterviewQaOptions,
  type AddQuestionResult,
  type RecordAnswerResult,
  type GetSessionQaResult,
} from './interview-qa.js';

