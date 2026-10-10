import type { PluginUiContribution } from "@modera/plugin-sdk";
export function writeUi(): PluginUiContribution[] {
  return (["tool.result", "tool.approval"] as const).map((slot) => ({
    id: `modera.filesystem.write-${slot === "tool.approval" ? "approval" : "result"}`,
    slot,
    hostRenderer: "write-result",
    toolNames: ["filesystem_create", "filesystem_replace_edit"],
    requiredPermissions: ["workspace.read"],
    async render(request) {
      if (slot === "tool.approval" && !request.tool?.result) throw new Error("Approval preview unavailable");
      const result = request.tool?.result ? JSON.parse(request.tool.result) : null;
      return {
        title: request.locale.startsWith("zh") ? "文件变更" : "File changes",
        data: { ...result, approval: slot === "tool.approval" },
        children: [],
      };
    },
  }));
}
