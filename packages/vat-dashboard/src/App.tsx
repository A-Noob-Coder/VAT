import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  openStream,
  type CardDto,
  type EventDto,
  type StateDto,
  type StreamMessage,
} from './api';
import { ACCENTS, getThemePref, saveThemePref, type ThemeName } from './theme';
import ConfigPanel from './ConfigPanel';

const STATUSES: Array<{ id: CardDto['status']; num: string; label: string }> = [
  { id: 'backlog', num: '01', label: '待规划' },
  { id: 'ready', num: '02', label: '就绪' },
  { id: 'developing', num: '03', label: '开发中' },
  { id: 'review', num: '04', label: '评审' },
  { id: 'testing', num: '05', label: '验收' },
  { id: 'done', num: '06', label: '已交付' },
];

const STAGE_LABEL: Record<string, string> = {
  requirement_approval: '需求批准',
  release_approval: '发布批准',
};

type Tab = 'board' | 'events' | 'ledger' | 'config';

export default function App() {
  const [state, setState] = useState<StateDto | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('board');
  const [selected, setSelected] = useState<CardDto | null>(null);
  const [events, setEvents] = useState<EventDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const dayRef = useRef<string | null>(null);
  dayRef.current = day;

  const refresh = useCallback(async () => {
    try {
      setState(await api.state(dayRef.current));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, day]);

  useEffect(() => {
    const effective = day ?? state?.day;
    if (!effective) return;
    setEvents([]);
    return openStream(effective, (msg: StreamMessage) => {
      if (msg.kind === 'batch') setEvents(msg.events);
      else if (msg.kind === 'append') setEvents((prev) => [...prev, ...msg.events]);
      else if (msg.kind === 'state_dirty') void refresh();
    });
  }, [day, state?.day, refresh]);

  const pendingCheckpoints = useMemo(
    () => (state?.cards ?? []).filter((c) => c.checkpoint),
    [state]
  );
  const frozenCards = useMemo(() => (state?.cards ?? []).filter((c) => c.frozen), [state]);

  if (!state) {
    return (
      <div className="shell">
        <div className="loading">{error ? `✗ ${error}` : '正在加载工作区投影…'}</div>
      </div>
    );
  }

  return (
    <div className="shell">
      <header className="masthead">
        <div className="brand">
          <span className="brand-vat">VAT</span>
          <span className="brand-sub">虚拟团队驾驶舱 · {state.root}</span>
        </div>
        <div className="masthead-meta">
          <span className="mono dim">
            账本 {state.ledger.billableTokens.toLocaleString()} / {state.ledger.dailyLimit.toLocaleString()}
          </span>
          <ThemeSwitcher />
          {state.days.length > 1 && (
            <select
              className="day-select mono"
              value={day ?? state.day}
              onChange={(e) => setDay(e.target.value)}
            >
              {state.days.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          )}
        </div>
      </header>

      {(pendingCheckpoints.length > 0 || frozenCards.length > 0) && (
        <div className="alertbar">
          {pendingCheckpoints.map((c) => (
            <button key={c.id} className="alert-chip warn" onClick={() => setSelected(c)}>
              ⏸ {c.id} 等待{STAGE_LABEL[c.checkpoint?.stage ?? ''] ?? '批准'}
            </button>
          ))}
          {frozenCards.map((c) => (
            <button key={c.id} className="alert-chip danger" onClick={() => setSelected(c)}>
              ⛔ {c.id} 已熔断冻结
            </button>
          ))}
        </div>
      )}

      <nav className="tabs">
        {(
          [
            ['board', '看板'],
            ['events', `事件流 (${events.length})`],
            ['ledger', '账本'],
            ['config', '配置'],
          ] as Array<[Tab, string]>
        ).map(([id, label]) => (
          <button key={id} className={`tab ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
        <div className="tabs-spacer" />
        <NewReq onDone={refresh} />
      </nav>

      <main className="content">
        {tab === 'board' && <Board state={state} onSelect={setSelected} />}
        {tab === 'events' && <EventStream events={events} />}
        {tab === 'ledger' && <Ledger state={state} />}
        {tab === 'config' && <ConfigPanel onSaved={refresh} />}
      </main>

      {selected && (
        <CardModal
          card={state.cards.find((c) => c.id === selected.id) ?? selected}
          maxRejections={state.charter.breaker.max_rejections}
          onClose={() => setSelected(null)}
          onAction={refresh}
          onError={setError}
        />
      )}
    </div>
  );
}

// ---------- 看板 ----------

function Board({ state, onSelect }: { state: StateDto; onSelect: (c: CardDto) => void }) {
  return (
    <div className="board">
      {STATUSES.map((col) => {
        const cards = state.cards.filter((c) => c.status === col.id);
        return (
          <div className="col" key={col.id}>
            <div className="col-head">
              <span className="mono dim">{col.num}</span>
              <span className="col-title">{col.label}</span>
              <span className="mono dim">{cards.length}</span>
            </div>
            <div className="col-body">
              {cards.length === 0 && <div className="empty">空闲无在办</div>}
              {cards.map((c) => (
                <button className={`card ${c.frozen ? 'frozen' : ''}`} key={c.id} onClick={() => onSelect(c)}>
                  <div className="card-top mono">
                    <span>{c.id}</span>
                    <span className="bronze">{c.priority}</span>
                  </div>
                  <div className="card-title">{c.title}</div>
                  <div className="card-foot mono">
                    <span>{c.owner}</span>
                    <span className="row-gap">
                      {c.checkpoint && <em className="badge warn">待{STAGE_LABEL[c.checkpoint.stage] ?? '批准'}</em>}
                      {c.frozen && <em className="badge danger">FROZEN</em>}
                      {c.rejection_count > 0 && (
                        <em className="danger">
                          打回 {c.rejection_count}/{state.charter.breaker.max_rejections}
                        </em>
                      )}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------- 事件流 ----------

function EventStream({ events }: { events: EventDto[] }) {
  const list = [...events].reverse();
  return (
    <div className="events">
      {list.length === 0 && <div className="empty">暂无事件 — 在终端 vat run 驱动流水线, 此处实时滚动</div>}
      {list.map((e, i) => (
        <div key={`${e.ts}-${i}`} className={`event sev-${e.severity}`}>
          <span className="mono dim">{new Date(e.ts).toLocaleTimeString()}</span>
          <span className={`mono sev-tag ${e.severity}`}>{e.severity}</span>
          <span className="mono dim">[{e.type}]</span>
          <span>{e.message}</span>
        </div>
      ))}
    </div>
  );
}

// ---------- 账本 ----------

function Ledger({ state }: { state: StateDto }) {
  const { ledger } = state;
  const pct = Math.min(100, Math.round((ledger.billableTokens / Math.max(1, ledger.dailyLimit)) * 100));
  return (
    <div className="ledger">
      <div className="stat-row">
        <Stat label="调用次数" value={String(ledger.calls)} />
        <Stat label="总 token" value={ledger.totalTokens.toLocaleString()} />
        <Stat label="计费口径 (真实 LLM)" value={ledger.billableTokens.toLocaleString()} />
      </div>
      <div className="budget">
        <div className="budget-label mono dim">
          日预算 {ledger.billableTokens.toLocaleString()} / {ledger.dailyLimit.toLocaleString()} ({pct}%)
        </div>
        <div className="budget-bar">
          <div className="budget-fill" style={{ width: `${pct}%` }} />
        </div>
      </div>
      <div className="ledger-grid">
        <div>
          <h3>按角色</h3>
          {Object.entries(ledger.byRole).length === 0 && <div className="empty">今日无调用</div>}
          {Object.entries(ledger.byRole).map(([role, tokens]) => (
            <div className="ledger-row mono" key={role}>
              <span>{role}</span>
              <span>{tokens.toLocaleString()}</span>
            </div>
          ))}
        </div>
        <div>
          <h3>按卡片</h3>
          {Object.entries(ledger.byCard).length === 0 && <div className="empty">今日无调用</div>}
          {Object.entries(ledger.byCard).map(([card, tokens]) => (
            <div className="ledger-row mono" key={card}>
              <span>{card}</span>
              <span>{tokens.toLocaleString()}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <div className="mono stat-value">{value}</div>
      <div className="dim stat-label">{label}</div>
    </div>
  );
}

// ---------- 卡片详情与裁决 ----------

function CardModal({
  card,
  maxRejections,
  onClose,
  onAction,
  onError,
}: {
  card: CardDto;
  maxRejections: number;
  onClose: () => void;
  onAction: () => void;
  onError: (msg: string) => void;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      onAction();
      onClose();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="mono dim">
              {card.id} · {card.owner} · token {card.token_used}
            </div>
            <h2 className="serif">{card.title}</h2>
          </div>
          <button className="icon-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="modal-meta mono">
          <span>状态 {card.status}</span>
          <span>
            打回 {card.rejection_count}/{maxRejections}
          </span>
          <span>自修 {card.self_repair_count}</span>
          {card.checkpoint && <em className="badge warn">卡点 {STAGE_LABEL[card.checkpoint.stage]}</em>}
          {card.frozen && <em className="badge danger">FROZEN</em>}
        </div>

        {card.frozen_reason && <p className="frozen-reason">{card.frozen_reason}</p>}

        {card.checkpoint && (
          <div className="action-panel">
            <h3>裁决 · {STAGE_LABEL[card.checkpoint.stage]}</h3>
            <textarea
              className="note"
              placeholder="裁决意见 (驳回时必填)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <div className="action-row">
              <button
                className="btn primary"
                disabled={busy}
                onClick={() => run(() => api.approve(card.id, card.checkpoint!.stage, note || undefined))}
              >
                批准并放行
              </button>
              <button
                className="btn danger"
                disabled={busy || !note.trim()}
                title="驳回需填写意见"
                onClick={() => run(() => api.reject(card.id, card.checkpoint!.stage, note))}
              >
                驳回 (退回 backlog)
              </button>
            </div>
          </div>
        )}

        {card.frozen && (
          <div className="action-panel">
            <h3>熔断裁决恢复</h3>
            <textarea
              className="note"
              placeholder="裁决意见 (必填)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <div className="action-row">
              <button
                className="btn primary"
                disabled={busy || !note.trim()}
                onClick={() => run(() => api.resume(card.id, 'developing', note))}
              >
                从 developing 恢复 (交 DEV 重做)
              </button>
              <button
                className="btn"
                disabled={busy || !note.trim()}
                onClick={() => run(() => api.resume(card.id, 'review', note))}
              >
                从 review 恢复 (直接重审)
              </button>
              <button
                className="btn"
                disabled={busy || !note.trim()}
                onClick={() => run(() => api.resume(card.id, 'redesign', note))}
              >
                退回 backlog 重拆
              </button>
            </div>
          </div>
        )}

        <h3>需求原文</h3>
        <pre className="body">{card.body}</pre>

        <h3>交付物 ({card.deliverables.length})</h3>
        <div className="deliverables">
          {card.deliverables.map((d, i) => (
            <div className="deliverable mono" key={i}>
              <span className={`badge ${d.source === 'strict-runner' ? 'strict' : 'dim'}`}>{d.source}</span>
              <span className="badge">[{d.type}]</span>
              <span>{d.title}</span>
            </div>
          ))}
          {card.deliverables.length === 0 && <div className="empty">暂无交付物</div>}
        </div>

        <h3>单据链</h3>
        <div className="mono chain">{card.ticket_chain.join(' → ') || '—'}</div>
      </div>
    </div>
  );
}

// ---------- 需求录入 ----------

function NewReq({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [priority, setPriority] = useState('P1');
  const [err, setErr] = useState<string | null>(null);

  if (!open) {
    return (
      <button className="btn primary" onClick={() => setOpen(true)}>
        ＋ 提新需求
      </button>
    );
  }
  return (
    <div className="newreq">
      <input className="mono" placeholder="需求标题" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
      <select className="mono" value={priority} onChange={(e) => setPriority(e.target.value)}>
        {['P0', 'P1', 'P2'].map((p) => (
          <option key={p}>{p}</option>
        ))}
      </select>
      <textarea placeholder="需求详述 (可空, 默认同标题)" value={body} onChange={(e) => setBody(e.target.value)} />
      {err && <div className="danger mono">{err}</div>}
      <div className="action-row">
        <button
          className="btn primary"
          onClick={() => {
            api
              .req(title, body, priority)
              .then(() => {
                setOpen(false);
                setTitle('');
                setBody('');
                setErr(null);
                onDone();
              })
              .catch((e) => setErr((e as Error).message));
          }}
        >
          投递至 PM
        </button>
        <button className="btn" onClick={() => setOpen(false)}>
          取消
        </button>
      </div>
    </div>
  );
}

// ---------- 主题切换器 ----------

function ThemeSwitcher() {
  const [pref, setPref] = useState<{ theme: ThemeName; accent: string }>(getThemePref());
  const change = (next: { theme: ThemeName; accent: string }) => {
    setPref(next);
    saveThemePref(next);
  };
  return (
    <div className="theme-switcher">
      <div className="theme-modes">
        {(['dark', 'light'] as ThemeName[]).map((m) => (
          <button
            key={m}
            className={`theme-mode ${pref.theme === m ? 'active' : ''}`}
            onClick={() => change({ ...pref, theme: m })}
            title={m === 'dark' ? '深色' : '浅色'}
          >
            {m === 'dark' ? '深' : '浅'}
          </button>
        ))}
      </div>
      <div className="theme-accents">
        {ACCENTS.map((a) => (
          <button
            key={a.id}
            className={`accent-dot ${pref.accent === a.color ? 'active' : ''}`}
            style={{ background: a.color }}
            title={a.name}
            onClick={() => change({ ...pref, accent: a.color })}
          />
        ))}
      </div>
    </div>
  );
}
