import { describe, expect, it } from 'vitest';
import {
  BACKGROUND_EXPORT_PROGRESS_MESSAGE,
  BACKGROUND_EXPORT_STATUS_MESSAGE,
  isBackgroundExportProgressMessage,
  isBackgroundExportStatusRequest,
} from '../src/shared/background-export-protocol';

describe('background export recovery protocol', () => {
  it('accepts a status request and rejects lookalike messages', () => {
    expect(isBackgroundExportStatusRequest({ type: BACKGROUND_EXPORT_STATUS_MESSAGE })).toBe(true);
    expect(isBackgroundExportStatusRequest({ type: BACKGROUND_EXPORT_STATUS_MESSAGE, jobId: 'leak' })).toBe(true);
    expect(isBackgroundExportStatusRequest({ type: 'telearchive.background-export.status.v0' })).toBe(false);
    expect(isBackgroundExportStatusRequest(null)).toBe(false);
  });

  it('keeps terminal progress recoverable after a source reload', () => {
    expect(isBackgroundExportProgressMessage({
      type: BACKGROUND_EXPORT_PROGRESS_MESSAGE,
      jobId: 'job-recovery-1234',
      phase: 'complete',
      text: 'Archive saved',
      pct: 100,
      messages: 42,
      receipt: {
        requestId: 'request-1', artifactId: 'artifact-1', downloadId: 9,
        filename: 'Chat.zip', size: 1024, state: 'complete',
      },
    })).toBe(true);
    expect(isBackgroundExportProgressMessage({
      type: BACKGROUND_EXPORT_PROGRESS_MESSAGE,
      jobId: 'job-recovery-1234',
      phase: 'complete',
      text: 'Archive saved',
      pct: 101,
      messages: 42,
    })).toBe(false);
  });
});
