import React from "react";
import { AgentFileChange, ToolExecution, parseToolOutput, type AgentFileChangeData } from "@modera/ui";
import type { PluginToolRendererProps } from "@modera/plugin-sdk";
export default function WriteResult({ call, result, state, title, locale, open, onOpenChange, data, error }: PluginToolRendererProps) {
  const payload = data ?? (result ? parseToolOutput(result) : undefined);
  const value = (payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {}) as AgentFileChangeData;
  if (value.approval) return <AgentFileChange value={value} locale={locale} />;
  return <ToolExecution kind="edit" name={call.name} title={title} target={value.path} state={state} input={call.input} output={result ? parseToolOutput(result) : undefined} tone="amber" locale={locale} open={open} onOpenChange={onOpenChange}>
    <AgentFileChange value={value} locale={locale} />{error && <p role="alert">{error}</p>}
  </ToolExecution>;
}
