import manifest from "../plugin.json";
import { declaredTool } from "@modera/plugin-sdk";
import { randomUUID } from "node:crypto";
import type { ToolContext, ToolDefinition } from "@modera/plugin-sdk";
import { encodingSchema, encodeText, type TextEncoding } from "./codec";
import { snapshot, FILE_LIMIT } from "./file-snapshot";
import { fileReview } from "./review";
import { writeTarget } from "./write-path";
import { commitBatch, type FileChange } from "./batch-transaction";
import { WriteQueue } from "./write-queue";

export const batchDefinition = declaredTool(manifest, "workspace_batch_edit");
interface Input {
  files: {
    path: string;
    encoding?: TextEncoding;
    edits: {
      searchContent: string;
      replaceContent: string;
      occurrence?: number;
    }[];
  }[];
}
interface Plan {
  changes: FileChange[];
  root: string;
  session: string;
  project: string | undefined;
  expires: number;
}
export class BatchWriter {
  private plans = new Map<string, Plan>();
  constructor(private queue: WriteQueue) {}
  clear() {
    this.plans.clear();
  }
  prepare(raw: unknown, context: ToolContext) {
    return this.queue.run(async () => {
      const changes: FileChange[] = [];
      let bytes = 0,
        root = "";
      const seen = new Set<string>();
      for (const input of (raw as Input).files) {
        context.signal.throwIfAborted();
        const target = await writeTarget(context.workspacePath!, input.path);
        root = target.root;
        const key =
          process.platform === "win32"
            ? target.target.toLowerCase()
            : target.target;
        if (seen.has(key)) throw new Error("Duplicate file in batch");
        seen.add(key);
        const before = await snapshot(target.target, input.encoding);
        if (!before) throw new Error(`File not found: ${input.path}`);
        let after = before.text;
        for (const edit of input.edits) {
          if (!edit.searchContent) throw new Error("Search content required");
          const positions: number[] = [];
          let from = 0,
            index: number;
          while ((index = after.indexOf(edit.searchContent, from)) !== -1) {
            positions.push(index);
            from = index + edit.searchContent.length;
          }
          if (!positions.length)
            throw new Error(`Exact text not found: ${input.path}`);
          if (positions.length > 1 && edit.occurrence === undefined)
            throw new Error(`Ambiguous match: ${input.path}`);
          const position = positions[(edit.occurrence ?? 1) - 1];
          if (position === undefined) throw new Error("Invalid occurrence");
          after =
            after.slice(0, position) +
            edit.replaceContent +
            after.slice(position + edit.searchContent.length);
          if (
            after.includes("\0") ||
            encodeText(after, before.encoding).length > FILE_LIMIT
          )
            throw new Error("Edited file exceeds 2 MiB or is binary");
        }
        if (after === before.text)
          throw new Error(`No changes requested: ${input.path}`);
        bytes += Buffer.byteLength(after) + Buffer.byteLength(before.text);
        if (bytes > 8 * 1024 * 1024)
          throw new Error("Batch exceeds 8 MiB preview budget; split it");
        changes.push({
          path: input.path,
          target: target.target,
          before,
          after,
        });
      }
      if (!changes.length || changes.length > 8)
        throw new Error("Expected 1-8 files");
      for (const [id, plan] of this.plans)
        if (plan.expires < Date.now()) this.plans.delete(id);
      if (this.plans.size >= 4)
        throw new Error("Too many pending batch approvals");
      const token = randomUUID();
      this.plans.set(token, {
        changes,
        root,
        session: context.sessionId,
        project: context.projectId,
        expires: Date.now() + 600000,
      });
      return {
        input: { token },
        preview: this.review(changes, "preview"),
        dispose: () => {
          this.plans.delete(token);
        },
      };
    });
  }
  execute(raw: unknown, context: ToolContext) {
    return this.queue.run(async () => {
      const token = (raw as { token: string }).token,
        plan = this.plans.get(token);
      this.plans.delete(token);
      if (
        !plan ||
        plan.expires < Date.now() ||
        plan.session !== context.sessionId ||
        plan.project !== context.projectId
      )
        throw new Error("Invalid/expired batch approval");
      const root = (
        await writeTarget(context.workspacePath!, plan.changes[0]!.path)
      ).root;
      if (root !== plan.root) throw new Error("Workspace changed");
      await commitBatch(plan.changes, root, context);
      return this.review(plan.changes, "applied");
    });
  }
  private review(changes: FileChange[], status: string) {
    return {
      status,
      files: changes.map((change) => {
        const review = fileReview(change.before.text, change.after);
        return {
          path: change.path,
          encoding: change.before.encoding,
          bytes: encodeText(change.after, change.before.encoding).length,
          ...review,
          before: review.before.slice(0, 900),
          after: review.after.slice(0, 900),
          reviewIsExcerpt:
            review.reviewIsExcerpt ||
            review.before.length > 900 ||
            review.after.length > 900,
        };
      }),
    };
  }
}
