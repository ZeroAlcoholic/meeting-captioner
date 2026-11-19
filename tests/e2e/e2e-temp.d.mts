export declare const defaultBase: string;
export declare function currentRunId(
  env?: Record<string, string | undefined>,
  pid?: number,
  ppid?: number,
): number;
export declare function processAlive(pid: number): boolean;
export declare function createE2eTemp(options?: {
  base?: string;
  runId?: number;
  alive?: (pid: number) => boolean;
}): {
  tempDir(prefix: string): Promise<string>;
  sweepFinishedRuns(): Promise<string[]>;
  runDir: string;
};
export declare function e2eTempDir(prefix: string): Promise<string>;
