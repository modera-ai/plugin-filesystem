import type {
  PluginUiContribution,
  PluginUiNode,
  PluginUiView,
} from "@modera/plugin-sdk";

function view(input: unknown, locale: string, approval = false): PluginUiView {
  const result = input as {
    files?: unknown[];
    status?: string;
    path?: string;
    before?: string;
    after?: string;
    startLine?: number;
    reviewIsExcerpt?: boolean;
    bytes?: number;
  } | null;
  const zh = locale.startsWith("zh");
  const applied = result?.status === "applied";
  const children: PluginUiNode[] = [];
  if (result?.files)
    return {
      title: zh
        ? applied
          ? "批量修改已应用"
          : "确认批量文件变更"
        : applied
          ? "Batch applied"
          : "Review batch changes",
      children: result.files.flatMap(
        (file) =>
          view({ ...(file as object), status: result.status }, locale, approval)
            .children,
      ),
    };
  if (result?.path) children.push({ type: "text", text: result.path });
  if (!applied)
    children.push({
      type: "text",
      tone: "muted",
      text: zh
        ? "仅预览，尚未修改文件。请检查差异，应用仍需宿主审批。"
        : "Preview only; no files changed. Review differences; applying still requires host approval.",
    });
  if (typeof result?.before === "string" && typeof result?.after === "string")
    children.push({
      type: "diff",
      before: result.before,
      after: result.after,
      startLine: result.startLine ?? 1,
      truncated: result.reviewIsExcerpt ?? false,
    });
  if (applied)
    children.push({
      type: "text",
      text: `${result.bytes} bytes`,
      tone: "success",
    });
  return {
    title: zh
      ? approval
        ? "确认文件变更"
        : applied
          ? "文件修改已应用"
          : "文件修改预览"
      : approval
        ? "Review file changes"
        : applied
          ? "File change applied"
          : "File change preview",
    children,
  };
}
export function writeUi(): PluginUiContribution[] {
  const common = {
    toolNames: [
      "workspace_create",
      "workspace_replace_edit",
      "workspace_batch_edit",
    ],
    requiredPermissions: ["workspace.read"] as const,
  };
  return [
    {
      ...common,
      id: "modera.workspace.write-result",
      slot: "tool.result",
      async render(request) {
        return view(
          request.tool?.result ? JSON.parse(request.tool.result) : null,
          request.locale,
        );
      },
    },
    {
      ...common,
      id: "modera.workspace.write-approval",
      slot: "tool.approval",
      async render(request) {
        if (!request.tool?.result)
          throw new Error("Approval preview unavailable");
        const result = JSON.parse(request.tool.result);
        return view(result, request.locale, true);
      },
    },
  ];
}
