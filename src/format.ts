import { format } from "prettier/standalone";
import babel from "prettier/plugins/babel";
import typescript from "prettier/plugins/typescript";
import estree from "prettier/plugins/estree";
import postcss from "prettier/plugins/postcss";
import html from "prettier/plugins/html";
import markdown from "prettier/plugins/markdown";
import yaml from "prettier/plugins/yaml";
import { extname } from "node:path";
export async function formatText(path: string, source: string) {
  const parsers: Record<string, string> = {
    ".js": "babel",
    ".jsx": "babel",
    ".mjs": "babel",
    ".cjs": "babel",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".json": "json",
    ".css": "css",
    ".scss": "scss",
    ".html": "html",
    ".md": "markdown",
    ".yml": "yaml",
    ".yaml": "yaml",
  };
  const parser = parsers[extname(path).toLowerCase()];
  if (!parser) return source;
  return format(source, {
    parser,
    plugins: [babel, typescript, estree, postcss, html, markdown, yaml],
    endOfLine: source.includes("\r\n") ? "crlf" : "lf",
  });
}
