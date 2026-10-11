import { randomUUID } from "node:crypto";
import type { ToolContext } from "@modera/plugin-sdk";
import { replaceText } from "./edit-text";
import { copyText, type CopyInput } from "./copy-text";
import { FILE_LIMIT, hash, snapshot } from "./file-snapshot";
import { writeTarget } from "./write-path";
import { fileReview } from "./review";
import { encodeText, type TextEncoding } from "./codec";
import { WriteQueue } from "./write-queue";
import {
  applyChanges,
  verifyChanges,
  type FileChange,
} from "./write-transaction";

type Kind = "create" | "edit" | "copy";
interface Input extends Omit<Partial<CopyInput>, "mode"> {
  path: string;
  encoding?: TextEncoding;
  content?: string;
  overwrite?: boolean;
  searchContent?: string;
  replaceContent?: string;
  occurrence?: number;
  mode?: "preview" | "apply" | "insert" | "replace";
  phase?: "preview" | "apply";
  previewId?: string;
}
interface Plan {
  signature: string;
  changes: FileChange[];
  observed: FileChange[];
  root: string;
  session: string;
  project?: string;
  expires: number;
  result: Record<string, unknown>;
}
export class WorkspaceWriter {
  constructor(
    private queue = new WriteQueue(),
    private options: (context: ToolContext) => Promise<{
      autoFormat?: boolean;
      fuzzyMatching?: boolean;
    }> = async () => ({}),
  ) {}
  private plans = new Map<string, Plan>();
  clear(): void {
    this.plans.clear();
  }
  async prepare(kind: Kind, raw: unknown, context: ToolContext) {
    const input = raw as Input;
    const key = kind === "copy" ? "phase" : "mode";
    const preview = (await this.execute(
      kind,
      { ...input, [key]: "preview" },
      context,
    )) as { previewId: string };
    return {
      input: { ...input, [key]: "apply", previewId: preview.previewId },
      preview,
      dispose: () => {
        this.plans.delete(preview.previewId);
      },
    };
  }
  inspect(kind: Kind, raw: unknown, context: ToolContext): Promise<unknown> {
    return this.locked(kind, raw as Input, context, true);
  }
  execute(kind: Kind, raw: unknown, context: ToolContext): Promise<unknown> {
    return this.locked(kind, raw as Input, context);
  }
  private async locked(
    kind: Kind,
    input: Input,
    context: ToolContext,
    inspectOnly = false,
  ) {
    const root = context.workspacePath ?? process.cwd();
    const paths = [input.path];
    if (kind === "copy") {
      if (!input.sourceFilePath) throw new Error("sourceFilePath required");
      paths.push(input.sourceFilePath);
    }
    const targets = await Promise.all(
      paths.map((path) => writeTarget(root, path)),
    );
    const keys = targets.map(({ target }) =>
      process.platform === "win32" ? target.toLowerCase() : target,
    );
    return this.queue.run(
      () => this.run(kind, input, context, inspectOnly),
      keys,
    );
  }
  private async run(
    kind: Kind,
    input: Input,
    context: ToolContext,
    inspectOnly: boolean,
  ) {
    context.signal.throwIfAborted();
    const phase = kind === "copy" ? input.phase : input.mode;
    if (phase !== undefined && phase !== "preview" && phase !== "apply")
      throw new Error("Invalid mode");
    const { root, target } = await writeTarget(
      context.workspacePath ?? process.cwd(),
      input.path,
    );
    const { previewId: _id, phase: _phase, mode, ...args } = input;
    const signature = hash(
      JSON.stringify([kind, args, kind === "copy" ? (mode ?? "insert") : null]),
    );
    for (const [id, plan] of this.plans)
      if (plan.expires < Date.now()) this.plans.delete(id);
    if (phase === "apply") {
      const plan = this.plans.get(input.previewId ?? "");
      if (
        !plan ||
        plan.signature !== signature ||
        plan.root !== root ||
        plan.changes[0]!.target !== target ||
        plan.session !== context.sessionId ||
        plan.project !== context.projectId
      )
        throw new Error(
          "Invalid/expired preview; generate a new preview with the same arguments",
        );
      await verifyChanges(root, plan.observed);
      if (inspectOnly) return { status: "preview", ...plan.result };
      this.plans.delete(input.previewId!);
      await applyChanges(root, plan.changes, context, plan.observed);
      return { status: "applied", ...plan.result };
    }
    const before = await snapshot(target, input.encoding);
    let encoding = before?.encoding ?? input.encoding ?? "utf8",
      after: string;
    let matchedLine = 1,
      matchType = "exact",
      formatted = false;
    const metadata: Record<string, unknown> = {};
    const observed: FileChange[] = [],
      changes: FileChange[] = [];
    const options = await this.options(context);
    if (kind === "create") {
      if (typeof input.content !== "string")
        throw new Error("Content required");
      if (before && input.overwrite !== true)
        throw new Error("File exists; use overwrite=true or replace_edit");
      after = input.content;
    } else if (kind === "edit") {
      if (!before) throw new Error("File not found");
      if (!input.searchContent || typeof input.replaceContent !== "string")
        throw new Error("Search and replacement required");
      ({ after, matchedLine, matchType } = replaceText(
        before.text,
        input.searchContent,
        input.replaceContent,
        input.occurrence,
        options.fuzzyMatching,
        input.path,
      ));
    } else {
      const sourceTarget = await writeTarget(root, input.sourceFilePath!);
      const sameFile =
        process.platform === "win32"
          ? sourceTarget.target.toLowerCase() === target.toLowerCase()
          : sourceTarget.target === target;
      const source = sameFile
        ? before
        : await snapshot(sourceTarget.target, input.encoding);
      if (!source) throw new Error("Source file not found");
      const copied = copyText(
        source.text,
        before?.text ?? null,
        sameFile,
        input as CopyInput,
      );
      after = copied.after;
      encoding = before?.encoding ?? source.encoding;
      const { sourceAfter, after: _after, ...details } = copied;
      Object.assign(metadata, details, {
        sourceFilePath: input.sourceFilePath,
        deleteSource: input.deleteSource === true,
      });
      matchedLine = copied.matchedLineStart;
      if (!sameFile) {
        const sourceChange: FileChange = {
          path: input.sourceFilePath!,
          target: sourceTarget.target,
          before: source,
          after: sourceAfter,
          encoding: source.encoding,
        };
        observed.push(sourceChange);
        if (input.deleteSource) changes.push(sourceChange);
      }
    }
    const primary: FileChange = {
      path: input.path,
      target,
      before,
      after,
      encoding,
    };
    changes.unshift(primary);
    observed.unshift(primary);
    for (const change of changes) {
      if (options.autoFormat) {
        try {
          const { formatText } = await import("./format");
          const output = await formatText(change.path, change.after);
          formatted ||= output !== change.after;
          change.after = output;
        } catch {
          /* Invalid or unsupported syntax retains the requested edit. */
        }
      }
      if (
        change.after.includes("\0") ||
        encodeText(change.after, change.encoding).length > FILE_LIMIT
      )
        throw new Error("Expected text at most 2 MiB");
    }
    if (changes.every((change) => change.before?.text === change.after))
      throw new Error("No changes requested");
    context.signal.throwIfAborted();
    const result = {
      ...metadata,
      path: input.path,
      matchedLine,
      matchType,
      formatted,
      ...fileReview(before?.text ?? "", primary.after),
      beforeHash: before?.hash ?? null,
      afterHash: hash(encodeText(primary.after, encoding)),
      bytes: encodeText(primary.after, encoding).length,
      encoding,
      ...(kind === "copy"
        ? {
            changes: changes.map((change) => ({
              path: change.path,
              ...fileReview(change.before?.text ?? "", change.after),
              encoding: change.encoding,
            })),
          }
        : {}),
      ...(kind === "copy" && changes.length > 1
        ? {
            sourceReview: fileReview(
              changes[1]!.before!.text,
              changes[1]!.after,
            ),
          }
        : {}),
    };
    if (inspectOnly) return { status: "preview", ...result };
    while (this.plans.size >= 8)
      this.plans.delete(this.plans.keys().next().value!);
    const previewId = randomUUID();
    this.plans.set(previewId, {
      signature,
      changes,
      observed,
      root,
      session: context.sessionId,
      project: context.projectId,
      expires: Date.now() + 600_000,
      result,
    });
    return {
      status: "preview",
      previewId,
      ...result,
      expiresInSeconds: 600,
      message: "No files changed. Review the actual output before approval.",
    };
  }
}
