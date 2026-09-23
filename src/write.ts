import { randomUUID } from "node:crypto";
import { open, rename, link, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ToolContext } from "@modera/plugin-sdk";
import { FILE_LIMIT, hash, snapshot } from "./file-snapshot";
import { cleanParents, writeTarget } from "./write-path";
import { fileReview } from "./review";
import { encodeText, type TextEncoding } from "./codec";
import { WriteQueue } from "./write-queue";

interface Input {
  encoding?: TextEncoding;
  path: string;
  content?: string;
  overwrite?: boolean;
  searchContent?: string;
  replaceContent?: string;
  occurrence?: number;
  mode?: "preview" | "apply";
  previewId?: string;
}
interface Plan {
  encoding: TextEncoding;
  signature: string;
  before: Awaited<ReturnType<typeof snapshot>>;
  after: string;
  target: string;
  root: string;
  session: string;
  project?: string;
  expires: number;
}
export class WorkspaceWriter {
  constructor(private queue = new WriteQueue()) {}
  async prepare(kind: "create" | "edit", raw: unknown, context: ToolContext) {
    const input = raw as Input;
    const preview = (await this.execute(
      kind,
      { ...input, mode: "preview" },
      context,
    )) as { previewId: string };
    return {
      input: { ...input, mode: "apply", previewId: preview.previewId },
      preview,
      dispose: () => {
        this.plans.delete(preview.previewId);
      },
    };
  }
  inspect(
    kind: "create" | "edit",
    raw: unknown,
    context: ToolContext,
  ): Promise<unknown> {
    return this.queue.run(() => this.run(kind, raw as Input, context, true));
  }
  private plans = new Map<string, Plan>();
  clear(): void {
    this.plans.clear();
  }
  execute(
    kind: "create" | "edit",
    raw: unknown,
    context: ToolContext,
  ): Promise<unknown> {
    return this.queue.run(() => this.run(kind, raw as Input, context));
  }
  private async run(
    kind: "create" | "edit",
    input: Input,
    context: ToolContext,
    inspectOnly = false,
  ) {
    context.signal.throwIfAborted();
    if (!context.workspacePath) throw new Error("Project required");
    if (
      input.mode !== undefined &&
      input.mode !== "preview" &&
      input.mode !== "apply"
    )
      throw new Error("Invalid mode");
    const { root, target } = await writeTarget(
      context.workspacePath,
      input.path,
    );
    const signature = hash(
      JSON.stringify([
        kind,
        input.path,
        input.content,
        input.overwrite ?? false,
        input.searchContent,
        input.replaceContent,
        input.occurrence,
        input.encoding,
      ]),
    );
    for (const [id, plan] of this.plans)
      if (plan.expires < Date.now()) this.plans.delete(id);
    if (input.mode === "apply") {
      const plan = this.plans.get(input.previewId ?? "");
      if (
        !plan ||
        plan.signature !== signature ||
        plan.root !== root ||
        plan.target !== target ||
        plan.session !== context.sessionId ||
        plan.project !== context.projectId
      )
        throw new Error(
          "Invalid/expired preview; generate a new preview with the same arguments",
        );
      if (inspectOnly) {
        const current = await snapshot(target, plan.encoding);
        if (
          current?.hash !== plan.before?.hash ||
          current?.identity !== plan.before?.identity
        )
          throw new Error("File changed since preview");
        return {
          status: "preview",
          path: input.path,
          ...fileReview(plan.before?.text ?? "", plan.after),
        };
      }
      await this.apply(plan, input.path, context);
      this.plans.delete(input.previewId!);
      return {
        status: "applied",
        path: input.path,
        bytes: encodeText(plan.after, plan.encoding).length,
        hash: hash(encodeText(plan.after, plan.encoding)),
        encoding: plan.encoding,
        ...fileReview(plan.before?.text ?? "", plan.after),
      };
    }
    const before = await snapshot(target, input.encoding);
    const encoding = before?.encoding ?? input.encoding ?? "utf8";
    let after: string;
    let matchedLine = 1;
    if (kind === "create") {
      if (typeof input.content !== "string")
        throw new Error("Content required");
      if (before && input.overwrite !== true)
        throw new Error("File exists; use overwrite=true or replace_edit");
      after = input.content;
    } else {
      if (!before) throw new Error("File not found");
      if (!input.searchContent || typeof input.replaceContent !== "string")
        throw new Error("Search and replacement required");
      const matches: number[] = [];
      let offset = 0;
      while (
        (offset = before.text.indexOf(input.searchContent, offset)) !== -1
      ) {
        matches.push(offset);
        offset += input.searchContent.length;
      }
      if (!matches.length)
        throw new Error(
          "Exact text not found; read the file and preserve indentation/newlines",
        );
      if (matches.length > 1 && input.occurrence === undefined)
        throw new Error("Ambiguous match; specify occurrence");
      const occurrence = input.occurrence ?? 1;
      if (
        !Number.isInteger(occurrence) ||
        occurrence < 1 ||
        occurrence > matches.length
      )
        throw new Error("Invalid occurrence");
      const index = matches[occurrence - 1]!;
      matchedLine = before.text.slice(0, index).split("\n").length;
      after =
        before.text.slice(0, index) +
        input.replaceContent +
        before.text.slice(index + input.searchContent.length);
    }
    if (after.includes("\0") || encodeText(after, encoding).length > FILE_LIMIT)
      throw new Error("Expected text at most 2 MiB");
    if (before?.text === after) throw new Error("No changes requested");
    context.signal.throwIfAborted();
    // At most 8 plans (~32 MiB of source/replacement UTF-8 data); never store unbounded history.
    if (inspectOnly)
      return {
        status: "preview",
        path: input.path,
        ...fileReview(before?.text ?? "", after),
      };
    while (this.plans.size >= 8)
      this.plans.delete(this.plans.keys().next().value!);
    const previewId = randomUUID();
    this.plans.set(previewId, {
      encoding,
      signature,
      before,
      after,
      root,
      target,
      session: context.sessionId,
      ...(context.projectId ? { project: context.projectId } : {}),
      expires: Date.now() + 600_000,
    });
    return {
      status: "preview",
      previewId,
      path: input.path,
      matchedLine,
      ...fileReview(before?.text ?? "", after),
      beforeHash: before?.hash ?? null,
      afterHash: hash(encodeText(after, encoding)),
      bytes: encodeText(after, encoding).length,
      encoding,
      expiresInSeconds: 600,
      message:
        "No files changed. Review excerpts; apply with identical arguments and previewId.",
    };
  }
  private async apply(
    plan: Plan,
    path: string,
    context: ToolContext,
  ): Promise<void> {
    const created: string[] = [];
    let temporary: string | undefined;
    let committed = false;
    try {
      const check = await writeTarget(plan.root, path, true, created);
      if (check.root !== plan.root || check.target !== plan.target)
        throw new Error("Path changed");
      const current = await snapshot(plan.target, plan.encoding);
      if (
        current?.hash !== plan.before?.hash ||
        current?.identity !== plan.before?.identity
      )
        throw new Error("File changed since preview; generate a new preview");
      context.signal.throwIfAborted();
      temporary = join(dirname(plan.target), `.modera-${randomUUID()}.tmp`);
      const file = await open(
        temporary,
        "wx",
        plan.before ? plan.before.mode & 0o777 : 0o666,
      );
      try {
        await file.writeFile(encodeText(plan.after, plan.encoding));
        if (plan.before) await file.chmod(plan.before.mode & 0o777);
        await file.sync();
      } finally {
        await file.close();
      }
      await writeTarget(plan.root, path);
      const latest = await snapshot(plan.target, plan.encoding);
      if (
        latest?.hash !== plan.before?.hash ||
        latest?.identity !== plan.before?.identity
      )
        throw new Error("File changed during apply");
      context.signal.throwIfAborted();
      if (plan.before) await rename(temporary, plan.target);
      else await link(temporary, plan.target); // Atomic no-clobber publication: cannot overwrite a newly created file.
      committed = true;
    } finally {
      if (temporary) {
        try {
          await unlink(temporary);
        } catch {
          /* Rename already removed it, or OS cleanup is unavailable. */
        }
      }
      if (!committed) await cleanParents(created);
    }
  }
}
