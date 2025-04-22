// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../resource';
import { APIPromise } from '../../api-promise';
import { RequestOptions } from '../../internal/request-options';
import { path } from '../../internal/utils/path';

export class Outputs extends APIResource {
  /**
   * Get the output status and details for a specific target for a specific build
   */
  retrieve(
    id: string,
    params: OutputRetrieveParams,
    options?: RequestOptions,
  ): APIPromise<OutputRetrieveResponse> {
    const { target } = params;
    return this._client.get(path`/v1/builds/${id}/outputs/${target}`, options);
  }
}

export interface BuildStepOutputInProgress {
  status: 'in_progress';
}

export interface BuildStepOutputNotStarted {
  status: 'not_started';
}

export interface BuildStepOutputQueued {
  status: 'queued';
}

export type CommitBuildStep =
  | BuildStepOutputNotStarted
  | BuildStepOutputQueued
  | BuildStepOutputInProgress
  | CommitBuildStep.Completed;

export namespace CommitBuildStep {
  export interface Completed {
    completed: Completed.CommitPresentShape | Completed.MergeConflictShape | Completed.OtherConclusionShape;

    status: 'completed';
  }

  export namespace Completed {
    export interface CommitPresentShape {
      commit: CommitPresentShape.Commit;

      conclusion: 'error' | 'success' | 'warning' | 'note';
    }

    export namespace CommitPresentShape {
      export interface Commit {
        repo: Commit.Repo;

        sha: string;
      }

      export namespace Commit {
        export interface Repo {
          branch: string;

          name: string;

          owner: string;
        }
      }
    }

    export interface MergeConflictShape {
      conclusion: 'merge_conflict' | 'upstream_merge_conflict';

      merge_conflict_pr: MergeConflictShape.MergeConflictPr;
    }

    export namespace MergeConflictShape {
      export interface MergeConflictPr {
        number: number;

        repo: MergeConflictPr.Repo;
      }

      export namespace MergeConflictPr {
        export interface Repo {
          name: string;

          owner: string;
        }
      }
    }

    export interface OtherConclusionShape {
      conclusion: 'cancelled' | 'timed_out' | 'fatal' | 'payment_required' | 'noop' | 'version_bump';
    }
  }
}

export type LintBuildStep =
  | BuildStepOutputNotStarted
  | BuildStepOutputQueued
  | BuildStepOutputInProgress
  | LintBuildStep.Completed;

export namespace LintBuildStep {
  export interface Completed {
    completed: Completed.Completed;

    status: 'completed';
  }

  export namespace Completed {
    export interface Completed {
      conclusion:
        | 'success'
        | 'failure'
        | 'skipped'
        | 'cancelled'
        | 'action_required'
        | 'neutral'
        | 'timed_out';
    }
  }
}

export type TestBuildStep =
  | BuildStepOutputNotStarted
  | BuildStepOutputQueued
  | BuildStepOutputInProgress
  | TestBuildStep.Completed;

export namespace TestBuildStep {
  export interface Completed {
    completed: Completed.Completed;

    status: 'completed';
  }

  export namespace Completed {
    export interface Completed {
      conclusion:
        | 'success'
        | 'failure'
        | 'skipped'
        | 'cancelled'
        | 'action_required'
        | 'neutral'
        | 'timed_out';
    }
  }
}

export interface OutputRetrieveResponse {
  commit: CommitBuildStep;

  lint: LintBuildStep;

  test: TestBuildStep;
}

export interface OutputRetrieveParams {
  /**
   * The target to get the output for
   */
  target: 'node' | 'python' | 'go' | 'java' | 'kotlin' | 'ruby' | 'typescript';
}

export declare namespace Outputs {
  export {
    type BuildStepOutputInProgress as BuildStepOutputInProgress,
    type BuildStepOutputNotStarted as BuildStepOutputNotStarted,
    type BuildStepOutputQueued as BuildStepOutputQueued,
    type CommitBuildStep as CommitBuildStep,
    type LintBuildStep as LintBuildStep,
    type TestBuildStep as TestBuildStep,
    type OutputRetrieveResponse as OutputRetrieveResponse,
    type OutputRetrieveParams as OutputRetrieveParams,
  };
}
