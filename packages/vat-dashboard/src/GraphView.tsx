import { useEffect, useMemo, useState } from 'react';
import { api, type GraphDto } from './api';

const CX = 380;
const CY = 300;
const R = 218;

const SEAT_W = 120;
const SEAT_H = 46;
const CHK_W = 168;
const CHK_H = 42;
const CARD_W = 200;
const CARD_H = 68;

interface RingNode {
  key: string;
  kind: 'seat' | 'checkpoint';
  label: string;
  title?: string;
  pending?: number;
  active?: boolean;
  waiting?: boolean;
}

function trunc(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export default function GraphView({ refreshKey }: { refreshKey: unknown }) {
  const [graph, setGraph] = useState<GraphDto | null>(null);
  const [cardId, setCardId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.graph(cardId)
      .then((g) => {
        if (alive) {
          setGraph(g);
          setErr(null);
        }
      })
      .catch((e) => {
        if (alive) setErr((e as Error).message);
      });
    return () => {
      alive = false;
    };
  }, [cardId, refreshKey]);

  const ring = useMemo<RingNode[]>(() => {
    if (!graph) return [];
    const items: RingNode[] = [];
    // 按业务流顺序入环: USER → PM → (需求卡点) → …角色… → QA → (发布卡点) → OPS
    for (const s of graph.seats) {
      items.push({
        key: s.id,
        kind: 'seat',
        label: s.id,
        title: s.title,
        pending: s.pending,
        active: s.active,
      });
      if (s.id === 'PM') {
        const c = graph.checkpoints.find((x) => x.id === 'requirement_approval');
        if (c?.enabled) {
          items.push({
            key: `chk-${c.id}`,
            kind: 'checkpoint',
            label: `卡点 · ${c.label}${c.passed ? ' ✓' : ''}`,
            waiting: c.waiting,
          });
        }
      }
      if (s.id === 'QA') {
        const c = graph.checkpoints.find((x) => x.id === 'release_approval');
        if (c?.enabled) {
          items.push({
            key: `chk-${c.id}`,
            kind: 'checkpoint',
            label: `卡点 · ${c.label}${c.passed ? ' ✓' : ''}`,
            waiting: c.waiting,
          });
        }
      }
    }
    return items;
  }, [graph]);

  const pos = useMemo(() => {
    const m = new Map<string, { x: number; y: number }>();
    ring.forEach((n, i) => {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(1, ring.length);
      m.set(n.key, { x: CX + R * Math.cos(a), y: CY + R * Math.sin(a) });
    });
    return m;
  }, [ring]);

  if (err) return <div className="empty">✗ {err}</div>;
  if (!graph) return <div className="empty">加载图谱中…</div>;

  return (
    <div className="graphview">
      {graph.cards.length > 1 && (
        <div className="graph-card-chips">
          {graph.cards.map((c) => (
            <button
              key={c.id}
              className={`tab ${graph.card?.id === c.id ? 'active' : ''}`}
              onClick={() => setCardId(c.id)}
            >
              {c.id} · {trunc(c.title, 10)}
            </button>
          ))}
        </div>
      )}
      <svg viewBox="0 0 760 600" width="100%" role="img">
        <title>编排知识图谱: 席位环绕项目</title>
        <defs>
          <marker id="garrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M2 1L8 5L2 9" fill="none" stroke="var(--text-tertiary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </marker>
          <marker id="garrow-a" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M2 1L8 5L2 9" fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </marker>
        </defs>

        {/* 流转边 (节点之下) */}
        {graph.edges.map((e, i) => {
          const a = pos.get(e.from);
          const b = pos.get(e.to);
          if (!a || !b) return null;
          const lx = a.x + (b.x - a.x) * 0.32;
          const ly = a.y + (b.y - a.y) * 0.32 - 8;
          return (
            <g key={`${e.from}-${e.to}-${e.label}`}>
              <line
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                className={`graph-edge ${e.kind}${e.active ? ' active' : ''}`}
                markerEnd={e.active ? 'url(#garrow-a)' : 'url(#garrow)'}
              />
              <text x={lx} y={ly} textAnchor="middle" className="graph-edge-label">
                {e.label}
                {e.count > 1 ? ` ×${e.count}` : ''}
              </text>
            </g>
          );
        })}

        {/* 文件工件小片 (挂边 72% 处, 沿法线偏移避让中心卡) */}
        {graph.artifacts.map((a) => {
          const e = graph.edges.find((x) => `${x.from}->${x.to}:${x.label}` === a.edgeKey);
          if (!e) return null;
          const p1 = pos.get(e.from);
          const p2 = pos.get(e.to);
          if (!p1 || !p2) return null;
          const dx = p2.x - p1.x;
          const dy = p2.y - p1.y;
          const len = Math.hypot(dx, dy) || 1;
          const mx = p1.x + dx * 0.72 + (-dy / len) * 22;
          const my = p1.y + dy * 0.72 + (dx / len) * 22;
          const w = Math.min(172, a.label.length * 12 + 20);
          return (
            <g key={a.id} className="graph-chip">
              <rect x={mx - w / 2} y={my - 11} width={w} height={22} rx={6} />
              <text x={mx} y={my} textAnchor="middle" dominantBaseline="central">
                {trunc(a.label, 12)}
              </text>
              <title>{`${a.label} (由 ${a.role} 产出)`}</title>
            </g>
          );
        })}

        {/* 中心: 项目卡片 */}
        <g className="graph-node center">
          <rect x={CX - CARD_W / 2} y={CY - CARD_H / 2} width={CARD_W} height={CARD_H} rx={12} />
          <text x={CX} y={CY - 12} textAnchor="middle" dominantBaseline="central">
            {graph.card ? `${graph.card.id} · ${graph.card.status}` : '无进行中卡片'}
          </text>
          <text x={CX} y={CY + 14} textAnchor="middle" dominantBaseline="central" className="sub">
            {graph.card ? trunc(graph.card.title, 16) : '提交需求后点亮图谱'}
          </text>
          {graph.card && (
            <title>
              {`${graph.card.title}\nowner: ${graph.card.owner}\n已过卡点: ${graph.card.checkpoints_passed.join(', ') || '无'}`}
            </title>
          )}
        </g>

        {/* 环绕席位与卡点 */}
        {ring.map((n) => {
          const p = pos.get(n.key);
          if (!p) return null;
          const w = n.kind === 'checkpoint' ? CHK_W : SEAT_W;
          const h = n.kind === 'checkpoint' ? CHK_H : SEAT_H;
          const cls = `graph-node ${n.kind}${n.active ? ' active' : ''}${n.waiting ? ' waiting' : ''}`;
          const hasSub = n.kind === 'seat';
          return (
            <g key={n.key} className={cls}>
              <rect x={p.x - w / 2} y={p.y - h / 2} width={w} height={h} rx={9} />
              <text x={p.x} y={hasSub ? p.y - 6 : p.y} textAnchor="middle" dominantBaseline="central">
                {n.label}
              </text>
              {hasSub && (
                <text x={p.x} y={p.y + 12} textAnchor="middle" dominantBaseline="central" className="sub">
                  {n.title}
                </text>
              )}
              {(n.pending ?? 0) > 0 && (
                <>
                  <circle cx={p.x + w / 2 - 3} cy={p.y - h / 2 + 3} r={9} className="graph-badge" />
                  <text x={p.x + w / 2 - 3} y={p.y - h / 2 + 3} textAnchor="middle" dominantBaseline="central" className="graph-badge-text">
                    {n.pending}
                  </text>
                </>
              )}
              <title>
                {n.kind === 'checkpoint'
                  ? `${n.label}${n.waiting ? ' — 等待主程裁决' : ''}`
                  : `${n.label} (${n.title})\n收件箱待处理: ${n.pending ?? 0}`}
              </title>
            </g>
          );
        })}
      </svg>
      <div className="graph-legend">
        席位 = 角色员工 · 中心 = 项目卡片 · 小片 = 文件工件 · 实线 = 单据流转 · 虚线 = 反馈环 · 流动虚线 = 正在传递
      </div>
    </div>
  );
}
