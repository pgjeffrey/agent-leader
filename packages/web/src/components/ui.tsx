import type { ReactNode } from "react";
import { TASK_STATUS_META, normalizeProviderId, type ExecutorId, type TaskStatus } from "../types";
import { useProject } from "../store";

/**
 * 任务状态彩色胶囊标签
 */
export function StatusPill({
  status,
  lined,
  extra,
}: {
  status: TaskStatus;
  lined?: boolean;
  extra?: string | number;
}) {
  const meta = TASK_STATUS_META[status] ?? TASK_STATUS_META.pending;
  const label = extra !== undefined ? `${meta.label}  ${extra}` : meta.label;
  return (
    <span className={`pill ${meta.tone}${lined ? ` ${meta.tone}-line` : ""}`}>
      {label}
    </span>
  );
}

/**
 * 通用语气的胶囊标签
 */
export function TonePill({
  tone,
  children,
  lined,
}: {
  tone: "ok" | "warn" | "info" | "rework" | "neutral";
  children: ReactNode;
  lined?: boolean;
}) {
  return <span className={`pill ${tone}${lined ? ` ${tone}-line` : ""}`}>{children}</span>;
}

/**
 * 可指挥执行智能体下拉选择器（自动汇总已启用的 48 款目录及自定义 Provider）
 */
export function ExecutorSelect({
  value,
  onChange,
  id,
}: {
  value: ExecutorId;
  onChange: (id: ExecutorId) => void;
  id?: string;
}) {
  const { enabledProviders, providers } = useProject();
  const normalizedVal = normalizeProviderId(value);

  const options = [...enabledProviders];
  if (!options.some((p) => p.id === normalizedVal)) {
    const fallback = providers.find((p) => p.id === normalizedVal);
    if (fallback) {
      options.unshift(fallback);
    }
  }

  return (
    <select
      id={id}
      className="exec"
      value={normalizedVal}
      onChange={(e) => onChange(e.target.value)}
      onClick={(e) => e.stopPropagation()}
    >
      {options.map((ex) => (
        <option key={ex.id} value={ex.id}>
          {ex.name}
        </option>
      ))}
    </select>
  );
}
