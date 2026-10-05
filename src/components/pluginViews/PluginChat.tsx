// The `chat` plugin view node: a conversation thread with a composer pinned
// under it. Presentation only — every message, step and decision comes from
// the plugin; the host owns layout, scrolling, markdown, copy and the draft.
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { PluginChatMessage, PluginChatNode, PluginChatStep } from "../../types/plugin";
import { parseMarkdown, type MdBlock, type MdInline } from "../../utils/miniMarkdown";
import "./PluginChat.css";

type OnAction = (actionId: string, data?: unknown) => void;

// How close to the bottom (px) still counts as "following along": new content
// scrolls into view only then, so reading back up the thread isn't yanked down.
const FOLLOW_SLACK_PX = 80;
const COMPOSER_MAX_HEIGHT_PX = 220;

function Svg({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

const CopyIcon = () => <Svg size={15}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h9" /></Svg>;
const CheckIcon = () => <Svg size={15}><path d="M5 12.5l4.5 4.5L19 7.5" /></Svg>;
const ChevronIcon = () => <Svg size={14}><path d="M9 6l6 6-6 6" /></Svg>;
const PlusIcon = () => <Svg size={18}><path d="M12 5v14M5 12h14" /></Svg>;
const SendIcon = () => <Svg size={16}><path d="M12 19V5M6 11l6-6 6 6" /></Svg>;
const StopIcon = () => <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect width="12" height="12" rx="2" fill="currentColor" /></svg>;

/** The working indicator: an asterisk that turns while the turn runs. */
function Spark({ size = 24 }: { size?: number }) {
  const rays = [0, 22.5, 45, 67.5, 90, 112.5, 135, 157.5];
  return (
    <svg className="plugin-chat-spark" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      {rays.map((deg, i) => (
        <line key={deg} x1="12" y1={i % 2 ? 3.5 : 1.5} x2="12" y2={i % 2 ? 20.5 : 22.5} transform={`rotate(${deg} 12 12)`} stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      ))}
    </svg>
  );
}

function Inline({ nodes }: { nodes: MdInline[] }) {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.kind) {
          case "text":
            return <Fragment key={i}>{n.text}</Fragment>;
          case "code":
            return <code key={i} className="plugin-chat-code-inline">{n.text}</code>;
          case "strong":
            return <strong key={i}><Inline nodes={n.children} /></strong>;
          case "em":
            return <em key={i}><Inline nodes={n.children} /></em>;
          case "link":
            return (
              <a
                key={i}
                href={n.href}
                title={n.href}
                onClick={(e) => {
                  e.preventDefault();
                  openUrl(n.href).catch((err) => console.error("Failed to open chat link:", err));
                }}
              >
                <Inline nodes={n.children} />
              </a>
            );
        }
      })}
    </>
  );
}

function Markdown({ text }: { text: string }) {
  const blocks: MdBlock[] = parseMarkdown(text);
  return (
    <div className="plugin-chat-md">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case "p":
            return <p key={i}><Inline nodes={b.inline} /></p>;
          case "h": {
            const Tag = (["h3", "h4", "h5"] as const)[b.level - 1];
            return <Tag key={i}><Inline nodes={b.inline} /></Tag>;
          }
          case "ul":
            return <ul key={i}>{b.items.map((it, j) => <li key={j}><Inline nodes={it} /></li>)}</ul>;
          case "ol":
            return <ol key={i} start={b.start}>{b.items.map((it, j) => <li key={j}><Inline nodes={it} /></li>)}</ol>;
          case "code":
            return <pre key={i} className="plugin-chat-code"><code>{b.text}</code></pre>;
          case "quote":
            return <blockquote key={i}><Inline nodes={b.inline} /></blockquote>;
          case "hr":
            return <hr key={i} />;
          case "table":
            return (
              <div key={i} className="plugin-chat-table-wrap">
                <table>
                  <thead><tr>{b.header.map((c, j) => <th key={j}><Inline nodes={c} /></th>)}</tr></thead>
                  <tbody>{b.rows.map((r, j) => <tr key={j}>{r.map((c, k) => <td key={k}><Inline nodes={c} /></td>)}</tr>)}</tbody>
                </table>
              </div>
            );
        }
      })}
    </div>
  );
}

/** Only inline image data or https: a plugin's chat must not be able to point
 *  an <img> at a local file or a plain-http tracker. */
export function isChatImageSrc(src: unknown): src is string {
  return typeof src === "string" && (/^data:image\/[a-z0-9.+-]+;base64,/i.test(src) || /^https:\/\//i.test(src));
}

function ChatImages({ images }: { images: NonNullable<PluginChatMessage["images"]> }) {
  const shown = images.filter((im) => isChatImageSrc(im.src));
  const [broken, setBroken] = useState<Set<string>>(() => new Set());
  const visible = shown.filter((im) => !broken.has(im.src));
  if (!visible.length) return null;
  return (
    <div className={`plugin-chat-images${visible.length === 1 ? " is-single" : ""}`}>
      {visible.map((im, i) => (
        <img
          key={i}
          className="plugin-chat-image"
          src={im.src}
          alt={im.alt ?? ""}
          title={im.alt}
          loading="lazy"
          onError={() => setBroken((prev) => new Set(prev).add(im.src))}
        />
      ))}
    </div>
  );
}

/** "Used 3 tools" — what the summary row of a folded step group says. */
export function stepsSummary(steps: PluginChatStep[]): string {
  const running = steps.find((s) => s.status === "running");
  if (running) return running.label;
  const tools = steps.filter((s) => s.status !== "note");
  const failed = tools.filter((s) => s.status === "error").length;
  const declined = tools.filter((s) => s.status === "declined").length;
  let label = tools.length ? `Used ${tools.length} tool${tools.length === 1 ? "" : "s"}` : "Worked through it";
  if (failed) label += ` · ${failed} failed`;
  if (declined) label += ` · ${declined} declined`;
  return label;
}

function StepMark({ status }: { status: PluginChatStep["status"] }) {
  if (status === "running") return <span className="plugin-chat-step-mark plugin-chat-step-mark--running" />;
  const glyph = status === "error" ? "✕" : status === "declined" ? "⊘" : status === "note" ? "•" : "✓";
  return <span className={`plugin-chat-step-mark plugin-chat-step-mark--${status ?? "ok"}`}>{glyph}</span>;
}

function StepGroup({ steps, open, onToggle }: { steps: PluginChatStep[]; open: boolean; onToggle: () => void }) {
  const running = steps.some((s) => s.status === "running");
  return (
    <div className={`plugin-chat-steps${open ? " is-open" : ""}`}>
      <button type="button" className="plugin-chat-steps-summary" onClick={onToggle} aria-expanded={open}>
        {running && <span className="plugin-chat-step-mark plugin-chat-step-mark--running" />}
        <span className="plugin-chat-steps-label">{stepsSummary(steps)}</span>
        <span className="plugin-chat-steps-chevron"><ChevronIcon /></span>
      </button>
      {open && (
        <ol className="plugin-chat-step-list">
          {steps.map((s, i) => (
            <li key={i} className="plugin-chat-step">
              <StepMark status={s.status} />
              <div className="plugin-chat-step-body">
                <div className={s.status === "note" ? "plugin-chat-step-note" : "plugin-chat-step-label"}>{s.label}</div>
                {s.detail && <pre className="plugin-chat-step-detail">{s.detail}</pre>}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      className="plugin-chat-icon-btn"
      title={copied ? "Copied" : "Copy"}
      aria-label="Copy"
      onClick={() => {
        navigator.clipboard.writeText(text).then(
          () => setCopied(true),
          (e) => console.error("Failed to copy chat message:", e),
        );
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}

function Message({ msg, latest, stepsOpen, onToggleSteps, onAction }: { msg: PluginChatMessage; latest: boolean; stepsOpen: boolean; onToggleSteps: () => void; onAction?: OnAction }) {
  if (msg.role === "user") {
    return <div className="plugin-chat-msg plugin-chat-msg--user"><div className="plugin-chat-bubble">{msg.text}</div></div>;
  }
  if (msg.role === "error") {
    return <div className="plugin-chat-msg plugin-chat-msg--error" role="alert">{msg.text}</div>;
  }
  if (msg.role === "note") {
    return <div className="plugin-chat-msg plugin-chat-msg--note">{msg.text}</div>;
  }
  const steps = msg.steps ?? [];
  const actions = msg.actions ?? [];
  return (
    <div className={`plugin-chat-msg plugin-chat-msg--assistant${latest ? " is-latest" : ""}`}>
      {steps.length > 0 && <StepGroup steps={steps} open={stepsOpen} onToggle={onToggleSteps} />}
      {msg.images && msg.images.length > 0 && <ChatImages images={msg.images} />}
      {msg.text && <Markdown text={msg.text} />}
      {msg.text && (
        <div className="plugin-chat-msg-actions">
          <CopyButton text={msg.text} />
          {actions.map((a) => (
            <button key={a.id} type="button" className="plugin-chat-icon-btn" title={a.label} aria-label={a.label} onClick={() => onAction?.(a.action, a.data)}>
              {a.icon ? <Svg size={15}><path d={a.icon} /></Svg> : <span className="plugin-chat-icon-btn-text">{a.label}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <span className="plugin-chat-status-elapsed">{Math.max(0, Math.round((now - since) / 1000))}s</span>;
}

function Composer({ composer, busy, onAction }: { composer: PluginChatNode["composer"]; busy: boolean; onAction?: OnAction }) {
  const [draft, setDraft] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT_PX) + "px";
  }, [draft]);

  const canSend = !busy && !composer.disabled && draft.trim().length > 0;
  const submit = () => {
    if (!canSend) return;
    onAction?.(composer.action, { query: draft.trim() });
    setDraft("");
  };

  return (
    <div className="plugin-chat-composer">
      <textarea
        ref={ref}
        className="plugin-chat-input"
        rows={1}
        value={draft}
        placeholder={composer.placeholder ?? "Write a message…"}
        disabled={composer.disabled}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="plugin-chat-composer-bar">
        {composer.newAction ? (
          <button
            type="button"
            className="plugin-chat-icon-btn plugin-chat-icon-btn--lg"
            title={composer.newLabel ?? "New chat"}
            aria-label={composer.newLabel ?? "New chat"}
            onClick={() => onAction?.(composer.newAction!)}
          >
            <PlusIcon />
          </button>
        ) : <span />}
        <div className="plugin-chat-composer-right">
          {composer.footer && (
            composer.footerAction ? (
              <button type="button" className="plugin-chat-footer plugin-chat-footer--link" onClick={() => onAction?.(composer.footerAction!)}>
                {composer.footer}
              </button>
            ) : <span className="plugin-chat-footer">{composer.footer}</span>
          )}
          {busy && composer.stopAction ? (
            <button type="button" className="plugin-chat-send plugin-chat-send--stop" title="Stop" aria-label="Stop" onClick={() => onAction?.(composer.stopAction!)}>
              <StopIcon />
            </button>
          ) : (
            <button type="button" className="plugin-chat-send" title="Send" aria-label="Send" disabled={!canSend} onClick={submit}>
              <SendIcon />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function PluginChat({ node, onAction, fill }: { node: PluginChatNode; onAction?: OnAction; fill?: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  // Step groups start folded; this holds the ones the user opened.
  const [openSteps, setOpenSteps] = useState<Set<string>>(() => new Set());

  const busy = !!node.status || !!node.approval;
  const last = node.messages[node.messages.length - 1];
  const contentSig = `${node.messages.length}|${last?.text.length ?? 0}|${last?.steps?.length ?? 0}|${last?.images?.length ?? 0}|${node.status ? 1 : 0}|${node.approval ? 1 : 0}`;

  useLayoutEffect(() => {
    if (followRef.current) endRef.current?.scrollIntoView({ block: "end" });
  }, [contentSig]);

  const toggleSteps = (id: string) => {
    setOpenSteps((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className={`plugin-chat${fill ? " plugin-chat--fill" : ""}`}>
      <div
        className="plugin-chat-scroll"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_SLACK_PX;
        }}
      >
        <div className="plugin-chat-column">
          {node.notice && (
            <div className="plugin-chat-notice">
              <span>{node.notice.message}</span>
              {node.notice.action && (
                <button type="button" className="ds-btn ds-btn--ghost" onClick={() => onAction?.(node.notice!.action!)}>
                  {node.notice.actionLabel ?? "Open"}
                </button>
              )}
            </div>
          )}

          {node.messages.length === 0 && node.empty && (
            <div className="plugin-chat-empty">
              <Spark size={36} />
              {node.empty.title && <h2 className="plugin-chat-empty-title">{node.empty.title}</h2>}
              {node.empty.subtitle && <p className="plugin-chat-empty-subtitle">{node.empty.subtitle}</p>}
              {node.empty.suggestions && node.empty.suggestions.length > 0 && (
                <div className="plugin-chat-suggestions">
                  {node.empty.suggestions.map((s, i) => (
                    <button key={i} type="button" className="plugin-chat-suggestion" onClick={() => onAction?.(s.action, s.data)}>
                      {s.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {node.messages.map((m) => (
            <Message key={m.id} msg={m} latest={m === last} stepsOpen={openSteps.has(m.id)} onToggleSteps={() => toggleSteps(m.id)} onAction={onAction} />
          ))}

          {node.approval && (
            <div className="plugin-chat-approval" role="group" aria-label={node.approval.title}>
              <div className="plugin-chat-approval-title">{node.approval.title}</div>
              <pre className="plugin-chat-approval-message">{node.approval.message}</pre>
              <div className="plugin-chat-approval-actions">
                <button type="button" className="ds-btn ds-btn--primary" onClick={() => onAction?.(node.approval!.approveAction)}>
                  {node.approval.approveLabel ?? "Approve"}
                </button>
                {node.approval.approveAllAction && (
                  <button type="button" className="ds-btn ds-btn--secondary" onClick={() => onAction?.(node.approval!.approveAllAction!)}>
                    {node.approval.approveAllLabel ?? "Approve all"}
                  </button>
                )}
                <button type="button" className="ds-btn ds-btn--ghost" onClick={() => onAction?.(node.approval!.denyAction)}>
                  {node.approval.denyLabel ?? "Deny"}
                </button>
              </div>
            </div>
          )}

          {node.status && !node.approval && (
            <div className="plugin-chat-status" aria-live="polite">
              <Spark />
              <span className="plugin-chat-status-label">{node.status.label}</span>
              {node.status.since !== undefined && <Elapsed since={node.status.since} />}
            </div>
          )}
          <div ref={endRef} className="plugin-chat-end" />
        </div>
      </div>
      <div className="plugin-chat-composer-wrap">
        <Composer composer={node.composer} busy={busy} onAction={onAction} />
      </div>
    </div>
  );
}
