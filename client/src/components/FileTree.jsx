import { useState } from "react";
import { ChevronRight, ChevronDown, Folder, FileText, MessageSquare } from "lucide-react";
import { Card } from "./ui/Card";
import { fileElementId } from "../lib/parseDiff";

// Counts comments across every file in a subtree, so a folder can show an
// aggregate badge even when collapsed and its files aren't individually visible.
function countComments(node, commentCountForFile) {
  if (node.type === "file") return commentCountForFile(node.path);
  return node.children.reduce((sum, child) => sum + countComments(child, commentCountForFile), 0);
}

function CommentBadge({ count }) {
  if (count === 0) return null;
  return (
    <span
      title={`${count} comment${count === 1 ? "" : "s"}`}
      className="flex shrink-0 items-center gap-0.5 rounded-full bg-indigo-100 px-1.5 py-0.5 text-[10px] font-medium leading-none text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-400"
    >
      <MessageSquare size={10} className="shrink-0" />
      {count}
    </span>
  );
}

function TreeFile({ node, depth, active, onSelectFile, commentCount }) {
  return (
    <a
      href={`#${fileElementId(node.path)}`}
      onClick={(e) => {
        e.preventDefault();
        onSelectFile(node.path);
      }}
      title={node.path}
      style={{ paddingLeft: `${depth * 12 + 8}px` }}
      className={`flex items-center gap-1.5 rounded-md py-1 pr-2 text-xs transition-colors ${
        active
          ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-400"
          : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
      }`}
    >
      <FileText size={13} className="shrink-0 text-zinc-400" />
      <span className="min-w-0 flex-1 truncate">{node.name}</span>
      <CommentBadge count={commentCount} />
      {node.binary ? (
        <span className="shrink-0 text-[10px] text-zinc-400">bin</span>
      ) : (
        <span className="flex shrink-0 gap-1 font-mono text-[10px]">
          {node.additions > 0 && <span className="text-emerald-600 dark:text-emerald-400">+{node.additions}</span>}
          {node.deletions > 0 && <span className="text-red-600 dark:text-red-400">-{node.deletions}</span>}
        </span>
      )}
    </a>
  );
}

function TreeFolder({ node, depth, activePath, onSelectFile, commentCountForFile }) {
  const [open, setOpen] = useState(true);
  const folderCount = countComments(node, commentCountForFile);
  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{ paddingLeft: `${depth * 12 + 4}px` }}
        className="flex w-full items-center gap-1 rounded-md py-1 pr-2 text-left text-xs font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
      >
        {open ? <ChevronDown size={12} className="shrink-0" /> : <ChevronRight size={12} className="shrink-0" />}
        <Folder size={13} className="shrink-0 text-zinc-400" />
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
        {!open && <CommentBadge count={folderCount} />}
      </button>
      {open && (
        <div>
          {node.children.map((child) =>
            child.type === "folder" ? (
              <TreeFolder
                key={child.path}
                node={child}
                depth={depth + 1}
                activePath={activePath}
                onSelectFile={onSelectFile}
                commentCountForFile={commentCountForFile}
              />
            ) : (
              <TreeFile
                key={child.path}
                node={child}
                depth={depth + 1}
                active={child.path === activePath}
                onSelectFile={onSelectFile}
                commentCount={commentCountForFile(child.path)}
              />
            )
          )}
        </div>
      )}
    </div>
  );
}

export function FileTree({ tree, activePath, onSelectFile, commentCountForFile = () => 0 }) {
  return (
    <Card className="flex max-h-[calc(100vh-8rem)] flex-col gap-0.5 overflow-y-auto p-2">
      <div className="px-2 pb-1.5 text-xs font-semibold text-zinc-500 dark:text-zinc-400">
        Files changed
      </div>
      {tree.map((node) =>
        node.type === "folder" ? (
          <TreeFolder
            key={node.path}
            node={node}
            depth={0}
            activePath={activePath}
            onSelectFile={onSelectFile}
            commentCountForFile={commentCountForFile}
          />
        ) : (
          <TreeFile
            key={node.path}
            node={node}
            depth={0}
            active={node.path === activePath}
            onSelectFile={onSelectFile}
            commentCount={commentCountForFile(node.path)}
          />
        )
      )}
    </Card>
  );
}
