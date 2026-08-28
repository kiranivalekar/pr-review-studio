import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { PrismLight as SyntaxHighlighter } from "react-syntax-highlighter";
import jsx from "react-syntax-highlighter/dist/esm/languages/prism/jsx";
import tsx from "react-syntax-highlighter/dist/esm/languages/prism/tsx";
import javascript from "react-syntax-highlighter/dist/esm/languages/prism/javascript";
import typescript from "react-syntax-highlighter/dist/esm/languages/prism/typescript";
import python from "react-syntax-highlighter/dist/esm/languages/prism/python";
import php from "react-syntax-highlighter/dist/esm/languages/prism/php";
import css from "react-syntax-highlighter/dist/esm/languages/prism/css";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json";
import bash from "react-syntax-highlighter/dist/esm/languages/prism/bash";
import oneDark from "react-syntax-highlighter/dist/esm/styles/prism/one-dark";
import oneLight from "react-syntax-highlighter/dist/esm/styles/prism/one-light";
import { Check, Copy } from "lucide-react";
import { useIsDarkMode } from "../lib/useIsDarkMode";

// Registered up front (module load), not lazily — this is a small, fixed set of
// languages actually seen in reviewed diffs, so PrismLight only bundles these instead
// of every language Prism supports.
SyntaxHighlighter.registerLanguage("jsx", jsx);
SyntaxHighlighter.registerLanguage("tsx", tsx);
SyntaxHighlighter.registerLanguage("javascript", javascript);
SyntaxHighlighter.registerLanguage("typescript", typescript);
SyntaxHighlighter.registerLanguage("python", python);
SyntaxHighlighter.registerLanguage("php", php);
SyntaxHighlighter.registerLanguage("css", css);
SyntaxHighlighter.registerLanguage("json", json);
SyntaxHighlighter.registerLanguage("bash", bash);

function CodeBlock({ language, code }) {
  const isDark = useIsDarkMode();
  const [copied, setCopied] = useState(false);

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-zinc-300 dark:border-zinc-700">
      <div className="flex items-center justify-between border-b border-zinc-300 bg-zinc-50 px-2.5 py-1 text-[11px] font-medium text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400">
        <span className="font-mono">{language || "text"}</span>
        <button
          type="button"
          onClick={async () => {
            await navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-zinc-200/70 hover:text-zinc-700 dark:hover:bg-zinc-700 dark:hover:text-zinc-200"
        >
          {copied ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <SyntaxHighlighter
        language={language}
        style={isDark ? oneDark : oneLight}
        customStyle={{ margin: 0, background: "transparent", fontSize: "0.75rem", padding: "0.6rem 0.75rem" }}
        codeTagProps={{ style: { fontFamily: "inherit" } }}
        wrapLongLines
      >
        {code}
      </SyntaxHighlighter>
    </div>
  );
}

// Renders review-comment markdown: fenced code gets syntax highlighting + a copy
// button (matching the "quoted current code" / "I'd do this instead" pattern Claude is
// prompted to write), inline `code` gets a plain pill, everything else is plain prose.
export function Markdown({ children }) {
  return (
    <div className="markdown-body text-sm leading-relaxed text-zinc-800 dark:text-zinc-200">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // react-markdown wraps fenced code in <pre><code>; unwrap the <pre> since
          // CodeBlock already renders its own container, or nesting doubles the border.
          pre({ children }) {
            return <>{children}</>;
          },
          code({ className, children }) {
            const match = /language-(\w+)/.exec(className || "");
            const text = String(children).replace(/\n$/, "");
            if (!match) {
              return (
                <code className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[0.85em] text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200">
                  {text}
                </code>
              );
            }
            return <CodeBlock language={match[1]} code={text} />;
          },
          p({ children }) {
            return <p className="mb-2 last:mb-0">{children}</p>;
          },
          ul({ children }) {
            return <ul className="mb-2 list-disc pl-5 last:mb-0">{children}</ul>;
          },
          ol({ children }) {
            return <ol className="mb-2 list-decimal pl-5 last:mb-0">{children}</ol>;
          },
          strong({ children }) {
            return <strong className="font-semibold text-zinc-900 dark:text-zinc-100">{children}</strong>;
          },
          a({ children, href }) {
            return (
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                className="text-indigo-600 hover:underline dark:text-indigo-400"
              >
                {children}
              </a>
            );
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
