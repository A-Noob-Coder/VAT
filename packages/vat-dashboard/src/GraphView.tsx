import { useEffect, useMemo, useState } from 'react';
import { api, type GraphDto } from './api';

const CX = 340;
const CY = 268;
const R = 205;

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
    const items: RingNode[] = graph.seats.map((s) => ({
      key: s.id,
      kind: 'seat',
      label: s.id,
      title: s.title,
      pending: s.pending,
      active: s.active,
    }));
    for (const c of graph.checkpoints) {
      if (c.enabled) {
        items.push({
          key: `chk-${c.id}`,
          kind: 'checkpoint',
          label: `卡点 · ${c.label}${c.passed ? ' ✓' : ''}`,
          waiting: c.waiting,
        });
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
      <svg viewBox="0 0 680 556" width="100%" role="img">
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
          const mx = (a.x + b.x) / 2;
          const my = (a.y + b.y) / 2;
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
              <text x={mx} y={my - 7} textAnchor="middle" className="graph-edge-label">
                {e.label}
                {e.count > 1 ? ` ×${e.count}` : ''}
              </text>
            </g>
          );
        })}

        {/* 文件工件小片 (挂边中点) */}
        {graph.artifacts.map((a) => {
          const e = graph.edges.find((x) => `${x.from}->${x.to}:${x.label}` === a.edgeKey);
          if (!e) return null;
          const p1 = pos.get(e.from);
          const p2 = pos.get(e.to);
          if (!p1 || !p2) return null;
          const mx = (p1.x + p2.x) / 2;
          const my = (p1.y + p2.y) / 2 + 16;
          const w = Math.min(160, a.label.length * 12 + 20);
          return (
            <g key={a.id} className="graph-chip">
              <rect x={mx - w / 2} y={my - 11} width={w} height={22} rx={6} />
              <text x={mx} y={my} textAnchor="middle" dominantBaseline="central">
                {trunc(a.label, 11)}
              </text>
              <title>{`${a.label} (由 ${a.role} 产出)`}</title>
            </g>
          );
        })}

        {/* 中心: 项目卡片 */}
        <g className="graph-node center">
          <rect x={CX - 92} y={CY - 32} width={184} height={64} rx={12} />
          <text x={CX} y={CY - 11} textAnchor="middle" dominantBaseline="central">
            {graph.card ? `${graph.card.id} · ${graph.card.status}` : '无进行中卡片'}
          </text>
          <text x={CX} y={CY + 13} textAnchor="middle" dominantBaseline="central" className="sub">
            {graph.card ? trunc(graph.card.title, 14) : '提交需求后点亮图谱'}
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
          const w = n.kind === 'checkpoint' ? 152 : 110;
          const h = n.kind === 'checkpoint' ? 38 : 44;
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
