import { useCallback, useEffect, useState } from 'react';
import { api } from './api';

type AnyObj = Record<string, any>;

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

/** 不可变地按路径设置值, 返回新对象 */
function setPath(obj: AnyObj, path: string[], value: unknown): AnyObj {
  const next = clone(obj);
  let cur: AnyObj = next;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    if (typeof cur[key] !== 'object' || cur[key] === null || Array.isArray(cur[key])) cur[key] = {};
    cur = cur[key] as AnyObj;
  }
  cur[path[path.length - 1]] = value;
  return next;
}

function getPath(obj: AnyObj | null, path: string[]): unknown {
  if (!obj) return undefined;
  let cur: AnyObj = obj;
  for (const key of path) {
    if (cur == null) return undefined;
    cur = cur[key];
  }
  return cur;
}

export default function ConfigPanel({ onSaved }: { onSaved?: () => void }) {
  const [cfg, setCfg] = useState<AnyObj | null>(null);
  const [charter, setCharter] = useState<AnyObj | null>(null);
  const [body, setBody] = useState('');
  const [raw, setRaw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await api.config();
      setCfg(d.config as AnyObj);
      setCharter(d.charter.data as AnyObj);
      setBody(d.charter.body);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const updateCfg = (path: string[], value: unknown) =>
    setCfg((c) => (c ? setPath(c, path, value) : c));
  const updateCharter = (path: string[], value: unknown) =>
    setCharter((c) => (c ? setPath(c, path, value) : c));

  const save = async () => {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      await api.saveConfig({ config: cfg ?? undefined, charterData: charter ?? undefined });
      setMsg('已保存到工作区 ✓');
      setTimeout(() => setMsg(null), 2500);
      onSaved?.();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!cfg || !charter) {
    return <div className="empty">{err ? `✗ ${err}` : '加载配置中…'}</div>;
  }

  const providers: AnyObj[] = Array.isArray(cfg.providers) ? cfg.providers : [];
  const modelChain: string[] = Array.isArray(cfg.modelChain) ? cfg.modelChain : [];
  const modelSettings: AnyObj = cfg.modelSettings ?? {};
  const roles: AnyObj[] = Array.isArray(charter.team?.roles) ? charter.team.roles : [];
  const roleModels: AnyObj = cfg.roleModels ?? {};

  const setProvider = (idx: number, key: string, value: unknown) => {
    const next = providers.map((p, i) => (i === idx ? { ...p, [key]: value } : p));
    updateCfg(['providers'], next);
  };
  const addProvider = () =>
    updateCfg(
      ['providers'],
      [
        ...providers,
        {
          id: `provider-${providers.length + 1}`,
          protocol: 'openai-compat',
          baseUrl: '',
          apiKeyEnv: 'TOKENRHYTHM_API_KEY',
          model: '',
          rpmLimit: 10,
          disableThinking: true,
        },
      ]
    );
  const removeProvider = (idx: number) =>
    updateCfg(['providers'], providers.filter((_, i) => i !== idx));

  const moveChain = (idx: number, dir: -1 | 1) => {
    const j = idx + dir;
    if (j < 0 || j >= modelChain.length) return;
    const next = [...modelChain];
    [next[idx], next[j]] = [next[j], next[idx]];
    updateCfg(['modelChain'], next);
  };

  const providersById = providers.map((p) => String(p.id));

  return (
    <div className="config">
      <div className="config-bar">
        <div className="config-bar-left">
          {msg && <span className="ok mono">{msg}</span>}
          {err && <span className="danger mono">{err}</span>}
        </div>
        <div className="config-bar-right">
          <button className="btn" onClick={() => setRaw((r) => !r)}>
            {raw ? '表单视图' : '原始 JSON'}
          </button>
          <button className="btn primary" disabled={busy} onClick={save}>
            {busy ? '保存中…' : '保存配置'}
          </button>
        </div>
      </div>

      {raw ? (
        <pre className="body config-raw">{JSON.stringify({ config: cfg, charter }, null, 2)}</pre>
      ) : (
        <div className="config-sections">
          {/* ---------- 模型供应商 ---------- */}
          <section className="cfg-section">
            <h3>模型供应商</h3>
            <p className="cfg-hint">每个供应商对应一条可容灾切换的模型通道。</p>
            {providers.map((p, i) => (
              <div className="cfg-card" key={i}>
                <div className="cfg-card-head">
                  <span className="mono bronze">#{i + 1}</span>
                  <span className="mono dim">{String(p.id)}</span>
                  <button className="icon-btn" title="删除" onClick={() => removeProvider(i)}>
                    ✕
                  </button>
                </div>
                <div className="cfg-grid">
                  <Field label="id">
                    <input
                      className="mono"
                      value={String(p.id ?? '')}
                      onChange={(e) => setProvider(i, 'id', e.target.value)}
                    />
                  </Field>
                  <Field label="协议 protocol">
                    <select
                      className="mono"
                      value={String(p.protocol ?? 'openai-compat')}
                      onChange={(e) => setProvider(i, 'protocol', e.target.value)}
                    >
                      {['openai-compat', 'anthropic', 'gemini'].map((x) => (
                        <option key={x}>{x}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="模型 model" wide>
                    <input
                      className="mono"
                      value={String(p.model ?? '')}
                      onChange={(e) => setProvider(i, 'model', e.target.value)}
                    />
                  </Field>
                  <Field label="baseUrl" wide>
                    <input
                      className="mono"
                      value={String(p.baseUrl ?? '')}
                      onChange={(e) => setProvider(i, 'baseUrl', e.target.value)}
                    />
                  </Field>
                  <Field label="apiKeyEnv">
                    <input
                      className="mono"
                      value={String(p.apiKeyEnv ?? '')}
                      onChange={(e) => setProvider(i, 'apiKeyEnv', e.target.value)}
                    />
                  </Field>
                  <Field label="rpmLimit">
                    <input
                      className="mono"
                      type="number"
                      value={Number(p.rpmLimit ?? 0)}
                      onChange={(e) => setProvider(i, 'rpmLimit', Number(e.target.value))}
                    />
                  </Field>
                  <Field label="disableThinking">
                    <label className="switch">
                      <input
                        type="checkbox"
                        checked={!!p.disableThinking}
                        onChange={(e) => setProvider(i, 'disableThinking', e.target.checked)}
                      />
                      <span>关闭深度思考</span>
                    </label>
                  </Field>
                </div>
              </div>
            ))}
            <button className="btn" onClick={addProvider}>
              ＋ 新增供应商
            </button>
          </section>

          {/* ---------- 模型链路 ---------- */}
          <section className="cfg-section">
            <h3>模型链路 (容灾顺序)</h3>
            <p className="cfg-hint">主模型在前, 失败自动顺延到下一个可用通道。</p>
            <div className="chain-edit">
              {modelChain.length === 0 && <div className="empty">未配置 modelChain</div>}
              {modelChain.map((id, i) => (
                <div className="chain-item" key={i}>
                  <span className="mono dim">{i + 1}</span>
                  <span className="mono">{id}</span>
                  <span className="chain-ops">
                    <button className="icon-btn" disabled={i === 0} onClick={() => moveChain(i, -1)}>
                      ↑
                    </button>
                    <button
                      className="icon-btn"
                      disabled={i === modelChain.length - 1}
                      onClick={() => moveChain(i, 1)}
                    >
                      ↓
                    </button>
                  </span>
                </div>
              ))}
            </div>
          </section>

          {/* ---------- 角色模型分配 ---------- */}
          <section className="cfg-section">
            <h3>角色模型分配</h3>
            <p className="cfg-hint">
              不同角色擅长不同领域, 可单独指定模型通道; 留空则跟随上方全局 modelChain。
            </p>
            {roles.length === 0 && <div className="empty">章程中暂无角色</div>}
            {roles.map((r) => {
              const roleId = String(r.id ?? '');
              const cur = roleModels[roleId] ?? '';
              const setRoleModel = (v: string) => {
                const next = { ...roleModels };
                if (!v) delete next[roleId];
                else next[roleId] = v;
                updateCfg(['roleModels'], next);
              };
              return (
                <div className="cfg-card" key={roleId}>
                  <div className="cfg-card-head">
                    <span className="mono bronze">{roleId}</span>
                    <span className="dim">{String(r.title ?? '')}</span>
                  </div>
                  <Field label="模型通道 (provider)">
                    <select
                      className="mono"
                      value={String(cur)}
                      onChange={(e) => setRoleModel(e.target.value)}
                    >
                      <option value="">跟随全局链路</option>
                      {providersById.map((pid) => (
                        <option key={pid} value={pid}>
                          {pid}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
              );
            })}
          </section>

          {/* ---------- 记忆窗口 ---------- */}
          <section className="cfg-section">
            <h3>模型记忆窗口</h3>
            <p className="cfg-hint">按供应商设置上下文压缩阈值 (字符/窗口数)。</p>
            {providersById.length === 0 && <div className="empty">无供应商</div>}
            {providersById.map((pid) => {
              const mem = (modelSettings[pid]?.memory ?? {}) as AnyObj;
              const setMem = (k: string, v: number) =>
                updateCfg(['modelSettings', pid, 'memory', k], v);
              return (
                <div className="cfg-card" key={pid}>
                  <div className="cfg-card-head">
                    <span className="mono bronze">{pid}</span>
                  </div>
                  <div className="cfg-grid">
                    <Field label="summaryWarnChars">
                      <input
                        className="mono"
                        type="number"
                        value={Number(mem.summaryWarnChars ?? 0)}
                        onChange={(e) => setMem('summaryWarnChars', Number(e.target.value))}
                      />
                    </Field>
                    <Field label="decisionWindow">
                      <input
                        className="mono"
                        type="number"
                        value={Number(mem.decisionWindow ?? 0)}
                        onChange={(e) => setMem('decisionWindow', Number(e.target.value))}
                      />
                    </Field>
                    <Field label="lessonWindow">
                      <input
                        className="mono"
                        type="number"
                        value={Number(mem.lessonWindow ?? 0)}
                        onChange={(e) => setMem('lessonWindow', Number(e.target.value))}
                      />
                    </Field>
                  </div>
                </div>
              );
            })}
          </section>

          {/* ---------- 工程 ---------- */}
          <section className="cfg-section">
            <h3>工程与编排</h3>
            <div className="cfg-grid">
              <Field label="git.autocommit">
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={!!getPath(cfg, ['git', 'autocommit'])}
                    onChange={(e) => updateCfg(['git', 'autocommit'], e.target.checked)}
                  />
                  <span>阶段完成自动提交</span>
                </label>
              </Field>
              <Field label="hub.maxConcurrentCards">
                <input
                  className="mono"
                  type="number"
                  value={Number(getPath(cfg, ['hub', 'maxConcurrentCards']) ?? 1)}
                  onChange={(e) => updateCfg(['hub', 'maxConcurrentCards'], Number(e.target.value))}
                />
              </Field>
            </div>
          </section>

          {/* ---------- 章程治理 ---------- */}
          <section className="cfg-section">
            <h3>章程治理 (agent.md)</h3>
            <p className="cfg-hint">预算 / 熔断 / 卡点 / 默认执行模式, 保存即重写章程。</p>
            <div className="cfg-grid">
              <Field label="预算 · 日 token 上限">
                <input
                  className="mono"
                  type="number"
                  value={Number(getPath(charter, ['budget', 'daily_token_limit']) ?? 0)}
                  onChange={(e) =>
                    updateCharter(['budget', 'daily_token_limit'], Number(e.target.value))
                  }
                />
              </Field>
              <Field label="预算 · 单卡片 token 上限">
                <input
                  className="mono"
                  type="number"
                  value={Number(getPath(charter, ['budget', 'per_card_token_limit']) ?? 0)}
                  onChange={(e) =>
                    updateCharter(['budget', 'per_card_token_limit'], Number(e.target.value))
                  }
                />
              </Field>
              <Field label="熔断 · 最大打回次数">
                <input
                  className="mono"
                  type="number"
                  value={Number(getPath(charter, ['circuit_breaker', 'max_rejections']) ?? 0)}
                  onChange={(e) =>
                    updateCharter(['circuit_breaker', 'max_rejections'], Number(e.target.value))
                  }
                />
              </Field>
              <Field label="执行模式 default_mode">
                <select
                  className="mono"
                  value={String(getPath(charter, ['execution', 'default_mode']) ?? 'draft')}
                  onChange={(e) => updateCharter(['execution', 'default_mode'], e.target.value)}
                >
                  {['draft', 'simulation', 'strict'].map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                </select>
              </Field>
              <Field label="卡点 · 需求批准">
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={!!getPath(charter, ['checkpoints', 'requirement_approval'])}
                    onChange={(e) =>
                      updateCharter(['checkpoints', 'requirement_approval'], e.target.checked)
                    }
                  />
                  <span>需求需 PM 批准后开工</span>
                </label>
              </Field>
              <Field label="卡点 · 发布批准">
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={!!getPath(charter, ['checkpoints', 'release_approval'])}
                    onChange={(e) =>
                      updateCharter(['checkpoints', 'release_approval'], e.target.checked)
                    }
                  />
                  <span>发布需批准后上线</span>
                </label>
              </Field>
            </div>
            <div className="cfg-card" style={{ marginTop: 14 }}>
              <div className="cfg-card-head">
                <span className="mono bronze">章程正文 (body)</span>
              </div>
              <textarea
                className="note"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                style={{ minHeight: 180 }}
              />
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function Field({ label, children, wide }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <label className={`field ${wide ? 'wide' : ''}`}>
      <span className="field-label mono">{label}</span>
      {children}
    </label>
  );
}
