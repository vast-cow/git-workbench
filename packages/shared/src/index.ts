export type Action =
  | "switch"
  | "branch"
  | "orphan"
  | "reset"
  | "merge"
  | "fetch"
  | "push"
  | "stage"
  | "unstage"
  | "commit";
export interface OperationInput {
  action: Action;
  name?: string;
  target?: string;
  tracking?: string;
  switchAfter?: boolean;
  message?: string;
  allowEmpty?: boolean;
  files?: string[];
  remotes?: string[];
  mode?: "normal" | "lease" | "force";
  review?: string;
  backup?: string;
}
export interface Review {
  token: string;
  head: string;
  branch: string;
  target?: string;
  lost?: string;
  remotes?: Record<string, string>;
  mode?: string;
}
export interface Repository {
  id: number;
  path: string;
}
export interface Operation {
  id: string;
  repo: string;
  type: string;
  params: string;
  before: string | null;
  after: string | null;
  started: number;
  duration: number | null;
  status: string;
  output: string;
  error: string | null;
}
