import { useEffect, useRef, useState } from "react";
import { useProject } from "../store";

const SUGGESTS = [
  "先看开发进度",
  "继续推进就绪任务",
  "换另一个执行器接手当前任务",
  "测试能不能一起准备？",
];

/**
 * 工作台底部全宽常驻指挥对话面板（用户唯一交互主入口）
 */
export function ChatPanel() {
  const { state, project, dispatch } = useProject();
  const [text, setText] = useState("");
  const log = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = log.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [project.messages.length, project.id]);

  function send(value?: string) {
    const v = (value ?? text).trim();
    if (!v) return;
    dispatch({ type: "SEND_MESSAGE", text: v });
    if (!value) setText("");
  }

  return (
    <section className="chat">
      <div className="chat-head">
        Agent Leader
        <span className="hint">
          单一指挥入口 · 由后台指挥大模型调度本机 Codex / Claude Code / Antigravity 等 48+ 款智能体协作验收
        </span>
      </div>
      <div className="chat-log" ref={log}>
        {project.messages.map((m) => (
          <div key={m.id} className={`bubble ${m.speaker === "user" ? "user" : ""}`}>
            <div className="who">
              {m.speaker === "user" ? "你" : "Agent Leader"}
              <span style={{ fontWeight: 400, marginLeft: 8, opacity: 0.65 }}>{m.at}</span>
            </div>
            <div>{m.text}</div>
          </div>
        ))}
      </div>
      <div className="suggests">
        {SUGGESTS.map((s) => (
          <button key={s} className="suggest" onClick={() => send(s)}>
            {s}
          </button>
        ))}
      </div>
      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <input
          className="field"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={
            state.brainStatus.phase === "chatting"
              ? "Agent Leader 正在思考回复…"
              : "向 Agent Leader 下达目标、调整约束、推进派工或要求换人……"
          }
        />
        <button className="btn-send" type="submit" disabled={!text.trim()}>
          发送
        </button>
      </form>
    </section>
  );
}
