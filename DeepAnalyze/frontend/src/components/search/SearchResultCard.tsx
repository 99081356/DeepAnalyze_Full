import React from "react";
import DOMPurify from "dompurify";

export interface SearchResultCardProps {
  pageId: string;
  title: string;
  snippet: string;
  level: "L0" | "L1" | "L2";
  score: number;
  kbId: string;
  docId?: string;
  onHover?: () => void;
  onLeave?: () => void;
  onClick?: () => void;
}

const levelConfig = {
  L0: { label: "L0 摘要", color: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400" },
  L1: { label: "L1 概述", color: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400" },
  L2: { label: "L2 原文", color: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400" },
};

export const SearchResultCard: React.FC<SearchResultCardProps> = ({
  title, snippet, level, score, onHover, onLeave, onClick,
}) => {
  const config = levelConfig[level];
  return (
    <div className="p-3 border rounded-lg hover:shadow-md transition-shadow cursor-pointer bg-white dark:bg-gray-800 dark:border-gray-700"
      onMouseEnter={onHover} onMouseLeave={onLeave} onClick={onClick}>
      <div className="flex items-center gap-2 mb-1">
        <span className={`px-2 py-0.5 rounded text-xs font-medium ${config.color}`}>{config.label}</span>
        <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100 flex-1 truncate">{title}</h4>
        <span className="text-xs text-gray-400">{(score * 100).toFixed(0)}%</span>
      </div>
      <div className="text-xs text-gray-600 dark:text-gray-400 line-clamp-3" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(snippet) }} />
    </div>
  );
};
