import { useCallback, useEffect, useState } from 'react';
import { api, type PathsDto } from './api';

type AnyObj = Record<string, any>;

type Section =
  | 'projects'
  | 'providers'
  | 'chain'
  | 'roles'
  | 'notify'
  | 'memory'
  | 'engineering'
  | 'charter'
  | 'raw';

const SECTIONS: Array<{ id: Section; icon: string; label: string; hint: string }> = [
  { id: 'projects', icon: '🗂', label: '项目与路径', hint: '工作区目录总览、各文件落盘位置; 注册多个项目文件夹并一键切换当前工作区。' },
  { id: 'providers', icon: '🧠', label: '模型供应商', hint: '每条供应商对应一个可调用的模型 API (协议/端点/密钥环境变量/限频)。' },
  { id: 'chain', icon: '🔗', label: '模型链路 · 容灾', hint: '按数组顺序容灾: 主模型在前, 429/5xx 冷却后自动顺延到下一个可用通道。' },
  { id: 'roles', icon: '👥', label: '角色模型分配', hint: '不同角色擅长不同领域, 可单独指定模型通道; 留空跟随全局链路。' },
  { id: 'notify', icon: '🔔', label: '通知渠道', hint: '需求澄清 / 熔断裁决等人工介入信号, 经邮件 / Webhook(企微飞书Slack) / 微信claw 推送。' },
  { id: 'memory', icon: '📦', label: '记忆窗口', hint: '按供应商设置上下文压缩阈值 (摘要预警字符 / 决策窗口 / 经验窗口)。' },
  { id: 'engineering', icon: '⚙️', label: '工程与编排', hint: 'git 阶段自动提交、同时编排的卡片并发数。' },
  { id: 'charter', icon: '📜', label: '章程治理', hint: '预算 / 熔断 / 卡点 / 默认执行模式, 保存即重写章程 agent.md。' },
];

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

const PATH_LABELS: Array<[string, string]> = [
  ['charterFile', '章程 (agent.md)'],
  ['configFile', '配置 (vat.config.json)'],
  ['boardDir', '看板卡片 board/'],
  ['ticketsDir', '单据信箱 tickets/'],
  ['heldDir', '卡点暂扣 tickets/_held/'],
  ['deadDir', '死信 tickets/_dead/'],
  ['memoryDir', '角色长期记忆 memory/'],
  ['tasksDir', '任务级记忆 tasks/'],
  ['projectsDir', '项目产物 projects/'],
  ['deliverablesDir', '交付物 deliverables/'],
  ['ledgerDir', '账本 ledger/'],
  ['eventsDir', '事件流 events/'],
  ['scenariosDir', '剧本 scenarios/'],
];

export default function ConfigPanel({ onSaved }: { onSaved?: () => void }) {
  const [cfg, setCfg] = useState<AnyObj | null>(null);
  const [charter, setCharter] = useState<AnyObj | null>(null);
  const [body, setBody] = useState('');
  const [pathsDto, setPathsDto] = useState<PathsDto | null>(null);
  const [section, setSection] = useState<Section>('projects');
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

  const loadPaths = useCallback(async () => {
    try {
      setPathsDto(await api.paths());
    } catch {
      // 路径接口失败不阻塞配置页
    }
  }, []);

  useEffect(() => {
    void load();
    void loadPaths();
  }, [load, loadPaths]);

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

  // ---------- 派生数据 ----------
  const providers: AnyObj[] = Array.isArray(cfg.providers) ? cfg.providers : [];
  const modelChain: string[] = Array.isArray(cfg.modelChain) ? cfg.modelChain : [];
  const modelSettings: AnyObj = cfg.modelSettings ?? {};
  const roles: AnyObj[] = Array.isArray(charter.team?.roles) ? charter.team.roles : [];
  const roleModels: AnyObj = cfg.roleModels ?? {};
  const projects: AnyObj[] = Array.isArray(cfg.projects) ? cfg.projects : [];
  const notifyCfg: AnyObj = cfg.notify ?? {};
  const channels: AnyObj[] = Array.isArray(notifyCfg.channels) ? notifyCfg.channels : [];
  const providersById = providers.map((p) => String(p.id));

  // ---------- 模型供应商 ----------
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

  // ---------- 模型链路 ----------
  const moveChain = (idx: number, dir: -1 | 1) => {
    const j = idx + dir;
    if (j < 0 || j >= modelChain.length) return;
    const next = [...modelChain];
    [next[idx], next[j]] = [next[j], next[idx]];
    updateCfg(['modelChain'], next);
  };

  // ---------- 角色模型分配 ----------
  const setRoleModel = (roleId: string, v: string) => {
    const next = { ...roleModels };
    if (!v) delete next[roleId];
    else next[roleId] = v;
    updateCfg(['roleModels'], next);
  };

  // ---------- 项目注册与切换 ----------
  const setProject = (idx: number, key: string, value: unknown) => {
    const next = projects.map((p, i) => (i === idx ? { ...p, [key]: value } : p));
    updateCfg(['projects'], next);
  };
  const addProject = () =>
    updateCfg(
      ['projects'],
      [...projects, { id: `proj-${projects.length + 1}`, name: '新项目', dir: '' }]
    );
  const removeProject = (idx: number) =>
    updateCfg(['projects'], projects.filter((_, i) => i !== idx));
  const switchTo = async (dir: string) => {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      await api.switchProject(dir);
      await Promise.all([load(), loadPaths()]);
      setMsg(`已切换工作区 → ${dir}`);
      setTimeout(() => setMsg(null), 3000);
      onSaved?.();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // ---------- 通知渠道 ----------
  const setChannel = (idx: number, key: string, value: unknown) => {
    const next = channels.map((c, i) => (i === idx ? { ...c, [key]: value } : c));
    updateCfg(['notify', 'channels'], next);
  };
  const addChannel = (type: 'email' | 'webhook' | 'wechat') => {
    const base: AnyObj =
      type === 'email'
        ? { id: `email-${channels.length + 1}`, type, enabled: true, to: '', from: 'vat@localhost', apiUrl: '', apiKeyEnv: 'VAT_MAIL_API_KEY' }
        : type === 'webhook'
          ? { id: `hook-${channels.length + 1}`, type, enabled: true, url: '', template: 'wecom' }
          : { id: `wx-${channels.length + 1}`, type, enabled: true, url: '', template: 'text' };
    updateCfg(['notify', 'channels'], [...channels, base]);
  };
  const removeChannel = (idx: number) =>
    updateCfg(['notify', 'channels'], channels.filter((_, i) => i !== idx));

  const active = SECTIONS.find((s) => s.id === section);

  return (
    <div className="settings">
      {/* ---------- 侧边栏 ---------- */}
      <nav className="settings-nav">
        <div className="settings-nav-title mono">设置中心</div>
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            className={`settings-nav-item ${section === s.id ? 'active' : ''}`}
            onClick={() => setSection(s.id)}
          >
            <span className="settings-nav-icon">{s.icon}</span>
            <span>{s.label}</span>
          </button>
        ))}
        <button
          className={`settings-nav-item ${section === 'raw' ? 'active' : ''}`}
          onClick={() => setSection('raw')}
        >
          <span className="settings-nav-icon">{'{ }'}</span>
          <span>原始 JSON</span>
        </button>
        <div className="settings-nav-spacer" />
        <button className="btn primary settings-save" disabled={busy} onClick={save}>
          {busy ? '保存中…' : '保存配置'}
        </button>
      </nav>

      {/* ---------- 内容面板 ---------- */}
      <div className="settings-pane">
        <div className="settings-pane-head">
          {active ? (
            <>
              <h2>
                <span className="settings-nav-icon">{active.icon}</span> {active.label}
              </h2>
              <p className="cfg-hint">{active.hint}</p>
            </>
          ) : (
            <h2>原始 JSON</h2>
          )}
          <div className="settings-msg">
            {msg && <span className="ok mono">{msg}</span>}
            {err && <span className="danger mono">{err}</span>}
          </div>
        </div>

        {section === 'raw' && (
          <pre className="body config-raw">{JSON.stringify({ config: cfg, charter }, null, 2)}</pre>
        )}

        {/* ---------- 项目与路径 ---------- */}
        {section === 'projects' && (
          <>
            <section className="cfg-section">
              <h3>当前工作区</h3>
              <div className="cfg-card paths-card">
                <div className="path-row">
                  <span className="field-label mono">根目录</span>
                  <span className="mono path-value bronze">{pathsDto?.root ?? '…'}</span>
                </div>
                {PATH_LABELS.map(([k, label]) => (
                  <div className="path-row" key={k}>
                    <span className="field-label mono">{label}</span>
                    <span className="mono path-value">{pathsDto?.paths?.[k] ?? '…'}</span>
                  </div>
                ))}
              </div>
              <p className="cfg-hint">
                以上目录由工作区根目录派生 (resolvePaths 规范); 切换项目即切换整棵目录树。
              </p>
            </section>

            <section className="cfg-section">
              <h3>项目注册表</h3>
              <p className="cfg-hint">
                为每个项目定义自己的文件夹; 「切换」会让驾驶舱与流水线指向该工作区 (保存后仍以切换为准)。
              </p>
              {projects.length === 0 && <div className="empty">尚未注册项目, 点击下方新增。</div>}
              {projects.map((p, i) => {
                const isCurrent = pathsDto?.root && p.dir && pathsDto.root === String(p.dir);
                return (
                  <div className="cfg-card" key={i}>
                    <div className="cfg-card-head">
                      <span className="mono bronze">{String(p.id)}</span>
                      {isCurrent && <span className="badge-ok mono">当前</span>}
                      <span className="dim" style={{ flex: 1 }} />
                      <button
                        className="btn"
                        disabled={busy || !p.dir || isCurrent}
                        onClick={() => void switchTo(String(p.dir))}
                      >
                        切换
                      </button>
                      <button className="icon-btn" title="删除" onClick={() => removeProject(i)}>
                        ✕
                      </button>
                    </div>
                    <div className="cfg-grid">
                      <Field label="id">
                        <input
                          className="mono"
                          value={String(p.id ?? '')}
                          onChange={(e) => setProject(i, 'id', e.target.value)}
                        />
                      </Field>
                      <Field label="名称">
                        <input
                          value={String(p.name ?? '')}
                          onChange={(e) => setProject(i, 'name', e.target.value)}
                        />
                      </Field>
                      <Field label="所在文件夹 dir (需含 agent.md)" wide>
                        <input
                          className="mono"
                          placeholder="D:/workspace/my-project"
                          value={String(p.dir ?? '')}
                          onChange={(e) => setProject(i, 'dir', e.target.value)}
                        />
                      </Field>
                    </div>
                  </div>
                );
              })}
              <button className="btn" onClick={addProject}>
                ＋ 注册项目
              </button>
            </section>
          </>
        )}

        {/* ---------- 模型供应商 ---------- */}
        {section === 'providers' && (
          <section className="cfg-section">
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
        )}

        {/* ---------- 模型链路 ---------- */}
        {section === 'chain' && (
          <section className="cfg-section">
            <div className="chain-edit">
              {modelChain.length === 0 && <div className="empty">未配置 modelChain</div>}
              {modelChain.map((id, i) => (
                <div className="chain-item" key={i}>
                  <span className="mono dim">{i === 0 ? '主' : `备${i}`}</span>
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
        )}

        {/* ---------- 角色模型分配 ---------- */}
        {section === 'roles' && (
          <section className="cfg-section">
            {roles.length === 0 && <div className="empty">章程中暂无角色</div>}
            {roles.map((r) => {
              const roleId = String(r.id ?? '');
              const cur = roleModels[roleId] ?? '';
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
                      onChange={(e) => setRoleModel(roleId, e.target.value)}
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
        )}

        {/* ---------- 通知渠道 ---------- */}
        {section === 'notify' && (
          <NotifySection
            channels={channels}
            onSet={setChannel}
            onAdd={addChannel}
            onRemove={removeChannel}
          />
        )}

        {/* ---------- 记忆窗口 ---------- */}
        {section === 'memory' && (
          <section className="cfg-section">
            <p className="cfg-hint">
              windowTokenLimit = 每角色 · 每任务会话窗口的 token 上限 (默认 262144 = 256k)。
              这是影响模型性能的压缩触发阈值, 不是全局总量封顶; 其余为字符级压缩参数。
            </p>
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
                    <Field label="windowTokenLimit (会话窗口 token 上限)">
                      <input
                        className="mono"
                        type="number"
                        placeholder="262144"
                        value={Number(mem.windowTokenLimit ?? 262144)}
                        onChange={(e) => setMem('windowTokenLimit', Number(e.target.value))}
                      />
                    </Field>
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
        )}

        {/* ---------- 工程与编排 ---------- */}
        {section === 'engineering' && (
          <section className="cfg-section">
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
        )}

        {/* ---------- 章程治理 ---------- */}
        {section === 'charter' && (
          <section className="cfg-section">
            <div className="cfg-grid">
              <Field label="预算 · 日 token 上限 (0 = 不限制)">
                <input
                  className="mono"
                  type="number"
                  value={Number(getPath(charter, ['budget', 'daily_token_limit']) ?? 0)}
                  onChange={(e) =>
                    updateCharter(['budget', 'daily_token_limit'], Number(e.target.value))
                  }
                />
              </Field>
              <Field label="预算 · 单卡片 token 上限 (0 = 不限制)">
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
        )}
      </div>
    </div>
  );
}

// ---------- 通知渠道版块 ----------

function NotifySection({
  channels,
  onSet,
  onAdd,
  onRemove,
}: {
  channels: AnyObj[];
  onSet: (idx: number, key: string, value: unknown) => void;
  onAdd: (type: 'email' | 'webhook' | 'wechat') => void;
  onRemove: (idx: number) => void;
}) {
  const [testing, setTesting] = useState<number | null>(null);
  const [result, setResult] = useState<Record<number, { ok: boolean; text: string }>>({});

  const test = async (idx: number) => {
    setTesting(idx);
    try {
      const r = await api.testNotify(channels[idx]);
      setResult((s) => ({ ...s, [idx]: { ok: true, text: `已送达: ${r.sent.join(', ')}` } }));
    } catch (e) {
      setResult((s) => ({ ...s, [idx]: { ok: false, text: (e as Error).message } }));
    } finally {
      setTesting(null);
    }
  };

  return (
    <section className="cfg-section">
      <p className="cfg-hint">
        当 PM 判定需求不明确或熔断需要裁决时, Hub 会把 notify 单据广播到所有启用的通道。
      </p>
      {channels.length === 0 && <div className="empty">未配置通知通道, 从下方新增。</div>}
      {channels.map((c, i) => {
        const t = String(c.type ?? 'webhook');
        const res = result[i];
        return (
          <div className="cfg-card" key={i}>
            <div className="cfg-card-head">
              <span className="mono bronze">{String(c.id)}</span>
              <span className="dim">{t}</span>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={c.enabled !== false}
                  onChange={(e) => onSet(i, 'enabled', e.target.checked)}
                />
                <span>启用</span>
              </label>
              <span style={{ flex: 1 }} />
              <button className="btn" disabled={testing === i} onClick={() => void test(i)}>
                {testing === i ? '发送中…' : '发送测试'}
              </button>
              <button className="icon-btn" title="删除" onClick={() => onRemove(i)}>
                ✕
              </button>
            </div>
            {res && (
              <div className={`mono ${res.ok ? 'ok' : 'danger'}`} style={{ marginBottom: 8 }}>
                {res.ok ? '✓ ' : '✗ '}
                {res.text}
              </div>
            )}
            <div className="cfg-grid">
              <Field label="id">
                <input
                  className="mono"
                  value={String(c.id ?? '')}
                  onChange={(e) => onSet(i, 'id', e.target.value)}
                />
              </Field>
              <Field label="类型 type">
                <select
                  className="mono"
                  value={t}
                  onChange={(e) => onSet(i, 'type', e.target.value)}
                >
                  {['email', 'webhook', 'wechat'].map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                </select>
              </Field>

              {t === 'email' && (
                <>
                  <Field label="收件人 to">
                    <input
                      className="mono"
                      value={String(c.to ?? '')}
                      onChange={(e) => onSet(i, 'to', e.target.value)}
                    />
                  </Field>
                  <Field label="发件人 from">
                    <input
                      className="mono"
                      value={String(c.from ?? '')}
                      onChange={(e) => onSet(i, 'from', e.target.value)}
                    />
                  </Field>
                  <Field label="邮件 API apiUrl (Resend 风格, 留空用默认)">
                    <input
                      className="mono"
                      placeholder="https://api.resend.com/emails"
                      value={String(c.apiUrl ?? '')}
                      onChange={(e) => onSet(i, 'apiUrl', e.target.value)}
                    />
                  </Field>
                  <Field label="apiKeyEnv">
                    <input
                      className="mono"
                      value={String(c.apiKeyEnv ?? '')}
                      onChange={(e) => onSet(i, 'apiKeyEnv', e.target.value)}
                    />
                  </Field>
                </>
              )}

              {t === 'webhook' && (
                <>
                  <Field label="Webhook URL" wide>
                    <input
                      className="mono"
                      placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…"
                      value={String(c.url ?? '')}
                      onChange={(e) => onSet(i, 'url', e.target.value)}
                    />
                  </Field>
                  <Field label="模板 template">
                    <select
                      className="mono"
                      value={String(c.template ?? 'wecom')}
                      onChange={(e) => onSet(i, 'template', e.target.value)}
                    >
                      {['wecom', 'feishu', 'slack', 'generic'].map((x) => (
                        <option key={x}>{x}</option>
                      ))}
                    </select>
                  </Field>
                </>
              )}

              {t === 'wechat' && (
                <>
                  <Field label="微信 claw 推送 URL" wide>
                    <input
                      className="mono"
                      placeholder="微信官方小龙虾插件的推送端点"
                      value={String(c.url ?? '')}
                      onChange={(e) => onSet(i, 'url', e.target.value)}
                    />
                  </Field>
                  <Field label="模板 template">
                    <select
                      className="mono"
                      value={String(c.template ?? 'text')}
                      onChange={(e) => onSet(i, 'template', e.target.value)}
                    >
                      {['text', 'markdown'].map((x) => (
                        <option key={x}>{x}</option>
                      ))}
                    </select>
                  </Field>
                </>
              )}
            </div>
          </div>
        );
      })}
      <div className="cfg-add-row">
        <button className="btn" onClick={() => onAdd('email')}>
          ＋ 邮件通道
        </button>
        <button className="btn" onClick={() => onAdd('webhook')}>
          ＋ Webhook (企微/飞书/Slack)
        </button>
        <button className="btn" onClick={() => onAdd('wechat')}>
          ＋ 微信 claw
        </button>
      </div>
    </section>
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
