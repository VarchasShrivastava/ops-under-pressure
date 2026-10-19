import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import {
  Activity, AlertCircle, ArrowDownWideNarrow, ArrowUpRight, Bell, BriefcaseBusiness,
  Check, CheckCheck, CheckCircle2, ChevronDown, CircleDot, Clock3, Filter, LayoutDashboard,
  LoaderCircle, LogOut, Plus, RefreshCw, Search, ShieldCheck, SlidersHorizontal, Users,
  X, Zap, Menu, Pencil, UserRound, CalendarDays, FileClock,
} from 'lucide-react'
import './App.css'

const API_BASE = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '')
const TOKEN_KEY = 'ops_access_token'

type Team = { id: string; name: string; slug: string; role: string }
type User = { id: string; email: string; displayName: string; isAdmin: boolean; teams?: Team[] }
type TimelineEntry = { id: string; entryType: 'event' | 'comment'; type: string; payload?: Record<string, unknown> | null; body?: string | null; actorId: string; actorName: string; createdAt: string }
type WorkItem = {
  id: string; teamId: string; title: string; description?: string | null; type: string; status: string;
  priority: string; createdBy: string; assigneeId: string | null; version: number; approvalStatus: string;
  approvedBy?: string | null; approvedAt?: string | null; createdAt: string; updatedAt: string; timeline?: TimelineEntry[]
}
type ListResponse = { items: WorkItem[]; nextCursor: string | null }
type ApiError = Error & { status?: number; payload?: any }

async function api<T>(path: string, token?: string | null, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers || {})
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  let response: Response
  try {
    response = await fetch(`${API_BASE}${path}`, { ...init, headers })
  } catch {
    throw new Error(`Cannot reach the API at ${API_BASE}. Check that the backend is running.`)
  }
  const raw = await response.text()
  let payload: any = null
  try { payload = raw ? JSON.parse(raw) : null } catch { payload = raw }
  if (!response.ok) {
    const message = Array.isArray(payload?.message) ? payload.message.join(', ') : payload?.message || payload?.error || `Request failed (${response.status})`
    const error = new Error(message) as ApiError
    error.status = response.status
    error.payload = payload
    throw error
  }
  return payload as T
}

const statuses = ['open', 'in_progress', 'awaiting_approval', 'resolved', 'closed']
const priorities = ['low', 'medium', 'high', 'urgent']
const types = [
  { value: 'operational_task', label: 'Operational task' },
  { value: 'customer_issue', label: 'Customer issue' },
  { value: 'engineering', label: 'Engineering' },
  { value: 'payment_investigation', label: 'Payment investigation' },
  { value: 'production_incident', label: 'Production incident' },
  { value: 'compliance', label: 'Compliance' },
]
const titleCase = (value?: string | null) => (value || 'Unknown').replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase())
const dateLabel = (value?: string | null) => value ? new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '—'
const initials = (name?: string) => (name || 'User').split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase()
const newKey = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`

function App() {
  const [token, setToken] = useState<string | null>(() => sessionStorage.getItem(TOKEN_KEY))
  const [user, setUser] = useState<User | null>(null)
  const [teams, setTeams] = useState<Team[]>([])
  const [items, setItems] = useState<WorkItem[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [query, setQuery] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [priorityFilter, setPriorityFilter] = useState('')
  const [teamFilter, setTeamFilter] = useState('')
  const [pageError, setPageError] = useState('')
  const [notice, setNotice] = useState('')
  const [loginEmail, setLoginEmail] = useState('member@ops.local')
  const [loginPassword, setLoginPassword] = useState('MemberLocal123!')
  const [loginBusy, setLoginBusy] = useState(false)
  const [loginError, setLoginError] = useState('')
  const [creating, setCreating] = useState(false)
  const [createBusy, setCreateBusy] = useState(false)
  const [selected, setSelected] = useState<WorkItem | null>(null)
  const [detailBusy, setDetailBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const [actionBusy, setActionBusy] = useState('')
  const [mobileNav, setMobileNav] = useState(false)
  const [newItem, setNewItem] = useState({ teamId: '', title: '', description: '', type: 'operational_task', priority: 'medium' })
  const [editItem, setEditItem] = useState({ title: '', description: '', type: 'operational_task', priority: 'medium' })

  const teamName = useCallback((id: string) => teams.find(team => team.id === id)?.name || 'Team', [teams])
  const currentTeam = useMemo(() => teams.find(team => team.id === teamFilter), [teams, teamFilter])

  const loadItems = useCallback(async (opts?: { append?: boolean; cursor?: string | null; quiet?: boolean }) => {
    if (!token) return
    const append = Boolean(opts?.append)
    if (append) setLoadingMore(true)
    else if (!opts?.quiet) setLoading(true)
    setPageError('')
    try {
      const params = new URLSearchParams()
      if (teamFilter) params.set('teamId', teamFilter)
      if (statusFilter) params.set('status', statusFilter)
      if (priorityFilter) params.set('priority', priorityFilter)
      if (query.trim()) params.set('q', query.trim())
      params.set('limit', '25')
      if (opts?.cursor) params.set('cursor', opts.cursor)
      const result = await api<ListResponse>(`/work-items?${params.toString()}`, token)
      setItems(previous => append ? [...previous, ...result.items] : result.items)
      setNextCursor(result.nextCursor)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not load work items.'
      setPageError(message)
      if ((error as ApiError).status === 401) signOut()
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  // signOut's behavior only needs the current token and is intentionally not listed as a data dependency.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, teamFilter, statusFilter, priorityFilter, query])

  const loadDetail = useCallback(async (id: string) => {
    if (!token) return
    setDetailBusy(true)
    try {
      const detail = await api<WorkItem>(`/work-items/${id}`, token)
      setSelected(detail)
      setEditItem({ title: detail.title, description: detail.description || '', type: detail.type || 'operational_task', priority: detail.priority || 'medium' })
    } catch (error) {
      setPageError(error instanceof Error ? error.message : 'Could not load item details.')
      if ((error as ApiError).status === 401) signOut()
    } finally { setDetailBusy(false) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  function signOut() {
    sessionStorage.removeItem(TOKEN_KEY)
    setToken(null); setUser(null); setTeams([]); setItems([]); setSelected(null); setNotice('')
  }

  useEffect(() => {
    if (!token) return
    let alive = true
    setPageError('')
    Promise.all([
      api<User>(`/auth/me`, token),
      api<Team[]>(`/teams`, token),
    ]).then(([profile, teamList]) => {
      if (!alive) return
      setUser(profile)
      setTeams(teamList)
      setNewItem(previous => ({ ...previous, teamId: previous.teamId || teamList[0]?.id || '' }))
    }).catch(error => {
      if (!alive) return
      setPageError(error instanceof Error ? error.message : 'Authentication could not be verified.')
      if ((error as ApiError).status === 401) signOut()
    })
    return () => { alive = false }
  }, [token])

  useEffect(() => {
    if (!token || !user) return
    const timer = window.setTimeout(() => { void loadItems() }, 220)
    return () => window.clearTimeout(timer)
  }, [token, user, loadItems])

  async function handleLogin(event: FormEvent) {
    event.preventDefault(); setLoginBusy(true); setLoginError('')
    try {
      const result = await api<{ accessToken: string; user: User }>('/auth/login', null, {
        method: 'POST', body: JSON.stringify({ email: loginEmail, password: loginPassword }),
      })
      sessionStorage.setItem(TOKEN_KEY, result.accessToken)
      setToken(result.accessToken); setUser(result.user); setTeams([]); setPageError('')
    } catch (error) { setLoginError(error instanceof Error ? error.message : 'Login failed.') }
    finally { setLoginBusy(false) }
  }

  async function handleCreate(event: FormEvent) {
    event.preventDefault()
    if (!token) return
    setCreateBusy(true); setPageError(''); setNotice('')
    try {
      const created = await api<WorkItem>('/work-items', token, {
        method: 'POST', headers: { 'Idempotency-Key': newKey() },
        body: JSON.stringify({ teamId: newItem.teamId, title: newItem.title, description: newItem.description, type: newItem.type, priority: newItem.priority }),
      })
      setCreating(false); setNewItem(previous => ({ ...previous, title: '', description: '', priority: 'medium', type: 'operational_task' }))
      setNotice('Work item created successfully.')
      await loadItems()
      await loadDetail(created.id)
    } catch (error) { setPageError(error instanceof Error ? error.message : 'Could not create work item.') }
    finally { setCreateBusy(false) }
  }

  async function performAction(action: string, method: string, body?: unknown, opts?: { idempotency?: boolean }) {
    if (!token || !selected) return
    setActionBusy(action); setPageError(''); setNotice('')
    try {
      const headers: Record<string, string> = {}
      if (opts?.idempotency) headers['Idempotency-Key'] = newKey()
      await api<WorkItem | { item: WorkItem }>(`/work-items/${selected.id}/${action}`, token, {
        method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      const successLabels: Record<string, string> = { claim: 'Item claimed.', start: 'Work started.', 'request-approval': 'Approval requested.', 'approval-decision': body && (body as { decision: string }).decision === 'approve' ? 'Work approved.' : 'Work sent back for changes.' }
      setNotice(successLabels[action] || 'Action completed.')
      await Promise.all([loadItems({ quiet: true }), loadDetail(selected.id)])
    } catch (error) {
      const apiError = error as ApiError
      if (apiError.status === 409) setPageError(`This item changed or is no longer available for that action. ${apiError.message} Refreshing the latest version may help.`)
      else setPageError(error instanceof Error ? error.message : 'Action failed.')
      if (apiError.status === 401) signOut()
      await Promise.all([loadItems({ quiet: true }), loadDetail(selected.id)])
    } finally { setActionBusy('') }
  }

  async function saveEdit(event: FormEvent) {
    event.preventDefault()
    if (!token || !selected) return
    setActionBusy('edit'); setPageError(''); setNotice('')
    try {
      const updated = await api<WorkItem>(`/work-items/${selected.id}`, token, {
        method: 'PATCH', headers: { 'If-Match': `"${selected.version}"` }, body: JSON.stringify(editItem),
      })
      setEditing(false); setNotice('Changes saved.')
      setSelected(updated)
      await loadItems({ quiet: true })
      await loadDetail(selected.id)
    } catch (error) {
      const apiError = error as ApiError
      setPageError(apiError.status === 409 ? 'This item was edited by someone else. The latest version has been reloaded; review it before trying again.' : error instanceof Error ? error.message : 'Could not save changes.')
      await Promise.all([loadItems({ quiet: true }), loadDetail(selected.id)])
    } finally { setActionBusy('') }
  }

  const counts = useMemo(() => ({
    open: items.filter(item => item.status === 'open').length,
    inProgress: items.filter(item => item.status === 'in_progress').length,
    awaiting: items.filter(item => item.status === 'awaiting_approval').length,
    urgent: items.filter(item => item.priority === 'urgent' && !['resolved', 'closed'].includes(item.status)).length,
  }), [items])

  const canApprove = selected && selected.status === 'awaiting_approval' && selected.createdBy !== user?.id && Boolean(teams.find(team => team.id === selected.teamId && team.role === 'lead'))
  const canStart = selected && selected.assigneeId === user?.id && selected.status === 'open'
  const canRequestApproval = selected && selected.assigneeId === user?.id && selected.status === 'in_progress'
  const canClaim = selected && !selected.assigneeId && ['open', 'in_progress'].includes(selected.status)

  if (!token) {
    return <div className="login-shell">
      <div className="login-brand"><div className="brand-mark"><Activity size={22} /></div><span>shift<span className="brand-light">ops</span></span></div>
      <div className="login-grid">
        <section className="login-story">
          <div className="eyebrow"><span className="pulse-dot" /> OPERATIONS COMMAND CENTER</div>
          <h1>Keep the work<br /><em>moving forward.</em></h1>
          <p>One calm place to coordinate teams, resolve issues, and keep every decision accountable.</p>
          <div className="login-proof"><div className="proof-icon"><ShieldCheck size={19} /></div><div><strong>Built for operational clarity</strong><span>Traceable changes · Team-based access · Safe concurrent updates</span></div></div>
          <div className="login-deco"><div className="deco-line" /><span>WORK SMARTER. RESPOND FASTER.</span></div>
        </section>
        <section className="login-card-wrap"><form className="login-card" onSubmit={handleLogin}>
          <div className="login-card-heading"><span className="mini-label">WELCOME BACK</span><h2>Sign in to ShiftOps</h2><p>Use your team account to continue.</p></div>
          {loginError && <div className="error-banner"><AlertCircle size={17} />{loginError}</div>}
          <label className="field-label" htmlFor="email">Work email</label><div className="input-icon"><UserRound size={17} /><input id="email" type="email" autoComplete="username" value={loginEmail} onChange={e => setLoginEmail(e.target.value)} required /></div>
          <label className="field-label" htmlFor="password">Password</label><input id="password" className="plain-input" type="password" autoComplete="current-password" value={loginPassword} onChange={e => setLoginPassword(e.target.value)} required />
          <button className="primary-button login-submit" disabled={loginBusy}>{loginBusy ? <LoaderCircle className="spin" size={17} /> : null}{loginBusy ? 'Signing in…' : 'Sign in'}<ArrowUpRight size={18} /></button>
          <div className="demo-note"><ShieldCheck size={15} /><span>Local development demo account is prefilled. Change credentials if needed.</span></div>
          <div className="login-api">API connected at <code>{API_BASE}</code></div>
        </form></section>
      </div>
      <div className="login-footer"><span>SHIFTOPS · WORK MANAGEMENT</span><span>Made for teams under pressure</span></div>
    </div>
  }

  return <div className="app-shell">
    <aside className={`sidebar ${mobileNav ? 'sidebar-open' : ''}`}>
      <div className="sidebar-brand"><div className="brand-mark"><Activity size={20} /></div><span>shift<span className="brand-light">ops</span></span><button className="icon-button nav-close" onClick={() => setMobileNav(false)} aria-label="Close navigation"><X size={18} /></button></div>
      <div className="workspace-switch"><div className="workspace-glyph">S</div><div className="workspace-copy"><strong>ShiftOps HQ</strong><span>Operations workspace</span></div><ChevronDown size={15} /></div>
      <div className="nav-caption">WORKSPACE</div>
      <nav className="sidebar-nav">
        <button className="nav-item active" onClick={() => setMobileNav(false)}><LayoutDashboard size={18} /><span>Overview</span><span className="nav-current" /></button>
        <button className="nav-item" onClick={() => { setStatusFilter(''); setPriorityFilter(''); setMobileNav(false) }}><BriefcaseBusiness size={18} /><span>All work items</span><span className="nav-number">{items.length}</span></button>
        <button className="nav-item" onClick={() => { setStatusFilter('awaiting_approval'); setMobileNav(false) }}><CheckCheck size={18} /><span>Approvals</span>{counts.awaiting > 0 && <span className="nav-badge">{counts.awaiting}</span>}</button>
      </nav>
      <div className="nav-caption team-caption">YOUR TEAMS <button className="tiny-icon" aria-label="Filter teams" onClick={() => setTeamFilter('')}><Plus size={14} /></button></div>
      <div className="team-nav">
        <button className={`team-item ${teamFilter === '' ? 'team-active' : ''}`} onClick={() => { setTeamFilter(''); setMobileNav(false) }}><span className="team-dot all-dot">✦</span><span>All accessible teams</span></button>
        {teams.map((team, index) => <button key={team.id} className={`team-item ${teamFilter === team.id ? 'team-active' : ''}`} onClick={() => { setTeamFilter(team.id); setMobileNav(false) }}><span className={`team-dot team-color-${index % 4}`}>{team.name.slice(0, 1).toUpperCase()}</span><span>{team.name}</span><span className="team-role">{team.role}</span></button>)}
      </div>
      <div className="sidebar-bottom"><div className="help-card"><div className="help-icon"><Zap size={16} /></div><div><strong>Keep work moving</strong><p>Every update is tracked in the activity timeline.</p></div></div><div className="profile-row"><div className="avatar">{initials(user?.displayName)}</div><div className="profile-copy"><strong>{user?.displayName || 'Loading profile'}</strong><span>{user?.isAdmin ? 'Administrator' : user?.email}</span></div><button className="icon-button logout-button" title="Sign out" onClick={signOut}><LogOut size={17} /></button></div></div>
    </aside>
    {mobileNav && <button className="mobile-scrim" aria-label="Close navigation" onClick={() => setMobileNav(false)} />}

    <main className="main-area">
      <header className="topbar"><div className="topbar-left"><button className="icon-button mobile-menu" onClick={() => setMobileNav(true)} aria-label="Open navigation"><Menu size={20} /></button><div className="breadcrumbs"><span>Workspace</span><span className="crumb-slash">/</span><strong>Overview</strong></div></div><div className="topbar-right"><div className="live-status"><span className="pulse-dot" /> System operational</div><button className="icon-button top-bell" title="Notifications" onClick={() => setNotice('You are all caught up.')}><Bell size={18} /><i /></button><div className="top-divider" /><div className="top-avatar">{initials(user?.displayName)}</div></div></header>
      <div className="page-content">
        <div className="welcome-row"><div><div className="date-kicker"><CalendarDays size={14} /> OPERATIONS OVERVIEW</div><h1>Good {new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 18 ? 'afternoon' : 'evening'}, {user?.displayName?.split(' ')[0] || 'there'} <span className="wave">✳</span></h1><p>Here's what's happening across your teams today.</p></div><button className="primary-button new-work-button" onClick={() => setCreating(true)}><Plus size={18} /> New work item</button></div>
        {pageError && <div className="error-banner page-message"><AlertCircle size={17} /><span>{pageError}</span><button className="icon-button" onClick={() => setPageError('')} aria-label="Dismiss error"><X size={16} /></button></div>}
        {notice && <div className="success-banner page-message"><CheckCircle2 size={17} /><span>{notice}</span><button className="icon-button" onClick={() => setNotice('')} aria-label="Dismiss message"><X size={16} /></button></div>}
        <section className="stats-grid">
          <StatCard label="Open items" value={counts.open} detail="Ready to be picked up" icon={<CircleDot size={18} />} tone="blue" loading={loading} />
          <StatCard label="In progress" value={counts.inProgress} detail="Currently being worked on" icon={<Activity size={18} />} tone="violet" loading={loading} />
          <StatCard label="Awaiting approval" value={counts.awaiting} detail="Needs a team lead review" icon={<Clock3 size={18} />} tone="amber" loading={loading} />
          <StatCard label="Urgent active" value={counts.urgent} detail="High attention required" icon={<Zap size={18} />} tone="rose" loading={loading} />
        </section>
        <section className="work-panel">
          <div className="panel-heading"><div><div className="section-eyebrow">LIVE QUEUE</div><h2>Work items <span className="count-pill">{items.length}{nextCursor ? '+' : ''}</span></h2><p>Stay on top of requests, incidents, and follow-ups.</p></div><button className="secondary-button refresh-button" onClick={() => void loadItems()} disabled={loading}><RefreshCw size={15} className={loading ? 'spin' : ''} /> Refresh</button></div>
          <div className="filters-bar"><div className="search-box"><Search size={17} /><input aria-label="Search work items" placeholder="Search title and description…" value={searchInput} onChange={e => { setSearchInput(e.target.value); setQuery(e.target.value) }} /><kbd>⌕</kbd></div><div className="filter-controls"><div className="select-wrap"><Filter size={15} /><select aria-label="Filter status" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}><option value="">All statuses</option>{statuses.map(status => <option key={status} value={status}>{titleCase(status)}</option>)}</select><ChevronDown size={14} /></div><div className="select-wrap"><ArrowDownWideNarrow size={15} /><select aria-label="Filter priority" value={priorityFilter} onChange={e => setPriorityFilter(e.target.value)}><option value="">All priorities</option>{priorities.map(priority => <option key={priority} value={priority}>{titleCase(priority)}</option>)}</select><ChevronDown size={14} /></div><button className={`filter-chip ${teamFilter ? 'filter-chip-active' : ''}`} onClick={() => setTeamFilter('')} title="Show all accessible teams"><SlidersHorizontal size={15} /><span>{currentTeam?.name || 'All teams'}</span>{teamFilter && <X size={13} />}</button></div></div>
          <div className="table-wrap"><table className="work-table"><thead><tr><th>WORK ITEM</th><th>STATUS</th><th>PRIORITY</th><th>ASSIGNEE</th><th>LAST UPDATED</th><th><span className="sr-only">Open</span></th></tr></thead><tbody>
            {loading && items.length === 0 ? <tr><td colSpan={6}><div className="table-state"><LoaderCircle className="spin" size={22} /><span>Loading your work queue…</span></div></td></tr> : items.length === 0 ? <tr><td colSpan={6}><div className="empty-state"><div className="empty-icon"><BriefcaseBusiness size={22} /></div><strong>No work items found</strong><p>Try changing your filters or create a new work item.</p><button className="secondary-button" onClick={() => { setSearchInput(''); setQuery(''); setStatusFilter(''); setPriorityFilter(''); setTeamFilter('') }}>Clear filters</button></div></td></tr> : items.map(item => <tr key={item.id} className="work-row" onClick={() => void loadDetail(item.id)} tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') void loadDetail(item.id) }}>
              <td><div className="item-title-cell"><div className={`item-type-icon type-${item.type}`}><BriefcaseBusiness size={16} /></div><div className="item-title-copy"><strong>{item.title}</strong><span>{teamName(item.teamId)} <span className="meta-dot">·</span> {titleCase(item.type)}</span></div></div></td>
              <td><StatusPill value={item.status} /></td><td><PriorityPill value={item.priority} /></td><td><div className="assignee-cell"><div className={`tiny-avatar ${item.assigneeId ? 'assigned' : ''}`}>{item.assigneeId ? <UserRound size={14} /> : <Users size={14} />}</div><span>{item.assigneeId ? item.assigneeId === user?.id ? 'You' : 'Assigned' : 'Unassigned'}</span></div></td><td><span className="updated-label">{dateLabel(item.updatedAt)}</span></td><td><button className="row-open" title="Open work item" onClick={e => { e.stopPropagation(); void loadDetail(item.id) }}><ArrowUpRight size={16} /></button></td>
            </tr>)}
          </tbody></table></div>
          <div className="table-footer"><span>Showing <strong>{items.length}</strong> loaded items{nextCursor ? ' · more available' : ''}</span>{nextCursor && <button className="secondary-button load-more" disabled={loadingMore} onClick={() => void loadItems({ append: true, cursor: nextCursor })}>{loadingMore && <LoaderCircle className="spin" size={15} />}{loadingMore ? 'Loading…' : 'Load more'}<ChevronDown size={15} /></button>}</div>
        </section>
        <footer className="page-footer"><span><ShieldCheck size={14} /> Changes are versioned and recorded automatically.</span><span>SHIFTOPS <span className="footer-dot">·</span> Operations under pressure</span></footer>
      </div>
    </main>

    {creating && <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget && !createBusy) setCreating(false) }}><section className="modal-card create-modal" role="dialog" aria-modal="true" aria-labelledby="create-title"><div className="modal-header"><div><span className="section-eyebrow">NEW REQUEST</span><h2 id="create-title">Create work item</h2><p>Give your team the context they need to get started.</p></div><button className="icon-button modal-close" onClick={() => setCreating(false)} disabled={createBusy} aria-label="Close"><X size={19} /></button></div><form onSubmit={handleCreate} className="modal-form"><label className="field-label">Team <span className="required">*</span></label><select className="form-control" value={newItem.teamId} onChange={e => setNewItem({ ...newItem, teamId: e.target.value })} required><option value="" disabled>Select a team</option>{teams.map(team => <option key={team.id} value={team.id}>{team.name}</option>)}</select><label className="field-label">Title <span className="required">*</span></label><input className="form-control" maxLength={200} value={newItem.title} onChange={e => setNewItem({ ...newItem, title: e.target.value })} placeholder="e.g. Investigate payment timeout" required /><label className="field-label">Description</label><textarea className="form-control form-textarea" rows={4} maxLength={10000} value={newItem.description} onChange={e => setNewItem({ ...newItem, description: e.target.value })} placeholder="Add relevant details, impact, or steps to reproduce…" /><div className="form-two-col"><div><label className="field-label">Work type</label><select className="form-control" value={newItem.type} onChange={e => setNewItem({ ...newItem, type: e.target.value })}>{types.map(type => <option key={type.value} value={type.value}>{type.label}</option>)}</select></div><div><label className="field-label">Priority</label><select className="form-control" value={newItem.priority} onChange={e => setNewItem({ ...newItem, priority: e.target.value })}>{priorities.map(priority => <option key={priority} value={priority}>{titleCase(priority)}</option>)}</select></div></div><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setCreating(false)} disabled={createBusy}>Cancel</button><button type="submit" className="primary-button" disabled={createBusy || !newItem.teamId || !newItem.title.trim()}>{createBusy ? <LoaderCircle size={16} className="spin" /> : <Plus size={17} />}{createBusy ? 'Creating…' : 'Create item'}</button></div></form></section></div>}

    {selected && <div className="modal-backdrop detail-backdrop" onMouseDown={e => { if (e.target === e.currentTarget && !actionBusy) { setSelected(null); setEditing(false) } }}><section className="modal-card detail-modal" role="dialog" aria-modal="true" aria-labelledby="detail-title"><div className="detail-topline"><div className="detail-id"><span className="item-type-icon detail-type-icon"><BriefcaseBusiness size={15} /></span><span>WORK ITEM</span><span className="meta-dot">/</span><code>{selected.id.slice(0, 8).toUpperCase()}</code><span className="version-chip">v{selected.version}</span></div><div className="detail-top-actions"><button className="icon-button" title="Refresh latest version" onClick={() => void loadDetail(selected.id)} disabled={detailBusy}><RefreshCw size={16} className={detailBusy ? 'spin' : ''} /></button><button className="icon-button" onClick={() => { setSelected(null); setEditing(false) }} aria-label="Close detail"><X size={19} /></button></div></div>
      {detailBusy && !selected.timeline ? <div className="detail-loading"><LoaderCircle size={24} className="spin" />Loading work item…</div> : <>
        <div className="detail-body"><div className="detail-main"><div className="detail-statusline"><StatusPill value={selected.status} /><PriorityPill value={selected.priority} /><span className="detail-team"><span className="team-dot team-color-0">{teamName(selected.teamId).slice(0, 1)}</span>{teamName(selected.teamId)}</span></div>
          {editing ? <form onSubmit={saveEdit} className="edit-form"><label className="field-label">Title</label><input className="form-control edit-title" value={editItem.title} onChange={e => setEditItem({ ...editItem, title: e.target.value })} maxLength={200} required /><label className="field-label">Description</label><textarea className="form-control form-textarea" rows={5} value={editItem.description} onChange={e => setEditItem({ ...editItem, description: e.target.value })} maxLength={10000} /><div className="form-two-col"><div><label className="field-label">Type</label><select className="form-control" value={editItem.type} onChange={e => setEditItem({ ...editItem, type: e.target.value })}>{types.map(type => <option key={type.value} value={type.value}>{type.label}</option>)}</select></div><div><label className="field-label">Priority</label><select className="form-control" value={editItem.priority} onChange={e => setEditItem({ ...editItem, priority: e.target.value })}>{priorities.map(priority => <option key={priority} value={priority}>{titleCase(priority)}</option>)}</select></div></div><div className="edit-actions"><button type="button" className="secondary-button" onClick={() => setEditing(false)} disabled={actionBusy === 'edit'}>Cancel</button><button className="primary-button" type="submit" disabled={actionBusy === 'edit'}>{actionBusy === 'edit' ? <LoaderCircle size={15} className="spin" /> : <Check size={16} />}{actionBusy === 'edit' ? 'Saving…' : 'Save changes'}</button></div></form> : <><h2 className="detail-title" id="detail-title">{selected.title}</h2><p className="detail-description">{selected.description?.trim() || 'No description has been added yet.'}</p><div className="detail-quick-actions">
            {canClaim && <button className="primary-button" onClick={() => void performAction('claim', 'POST', undefined, { idempotency: true })} disabled={Boolean(actionBusy)}>{actionBusy === 'claim' ? <LoaderCircle size={16} className="spin" /> : <UserRound size={16} />}{actionBusy === 'claim' ? 'Claiming…' : 'Claim item'}</button>}
            {canStart && <button className="primary-button" onClick={() => void performAction('start', 'POST')} disabled={Boolean(actionBusy)}>{actionBusy === 'start' ? <LoaderCircle size={16} className="spin" /> : <Activity size={16} />}{actionBusy === 'start' ? 'Starting…' : 'Start work'}</button>}
            {canRequestApproval && <button className="primary-button" onClick={() => void performAction('request-approval', 'POST')} disabled={Boolean(actionBusy)}>{actionBusy === 'request-approval' ? <LoaderCircle size={16} className="spin" /> : <CheckCheck size={16} />}{actionBusy === 'request-approval' ? 'Submitting…' : 'Request approval'}</button>}
            {canApprove && <><button className="primary-button approve-button" onClick={() => void performAction('approval-decision', 'POST', { decision: 'approve' })} disabled={Boolean(actionBusy)}>{actionBusy === 'approval-decision' ? <LoaderCircle size={16} className="spin" /> : <CheckCircle2 size={16} />}Approve</button><button className="secondary-button reject-button" onClick={() => void performAction('approval-decision', 'POST', { decision: 'reject' })} disabled={Boolean(actionBusy)}>Request changes</button></>}
            <button className="secondary-button" onClick={() => { setEditItem({ title: selected.title, description: selected.description || '', type: selected.type, priority: selected.priority }); setEditing(true) }} disabled={Boolean(actionBusy)}><Pencil size={15} /> Edit</button>
          </div></>}
          <div className="timeline-section"><div className="timeline-heading"><div><span className="section-eyebrow">AUDIT TRAIL</span><h3>Activity timeline</h3></div><span className="timeline-count">{selected.timeline?.length || 0} events</span></div>{selected.timeline?.length ? <div className="timeline-list">{selected.timeline.map(entry => <div className="timeline-entry" key={`${entry.entryType}-${entry.id}`}><div className={`timeline-marker ${entry.entryType === 'comment' ? 'marker-comment' : ''}`}>{entry.entryType === 'comment' ? <Users size={13} /> : <FileClock size={13} />}</div><div className="timeline-content"><div className="timeline-line"><strong>{entry.actorName}</strong><span>{entry.entryType === 'comment' ? 'commented' : titleCase(entry.type)}</span><time>{dateLabel(entry.createdAt)}</time></div>{entry.entryType === 'comment' ? <p>{entry.body}</p> : entry.payload && Object.keys(entry.payload).length > 0 ? <p className="timeline-payload">{Object.entries(entry.payload).map(([key, value]) => `${titleCase(key)}: ${String(value)}`).join(' · ')}</p> : null}</div></div>)}</div> : <div className="timeline-empty"><Clock3 size={17} /><span>No activity has been recorded yet.</span></div>}</div>
        </div><aside className="detail-side"><div className="detail-side-card"><h3>Properties</h3><Property label="Team" value={teamName(selected.teamId)} icon={<Users size={15} />} /><Property label="Assignee" value={selected.assigneeId ? selected.assigneeId === user?.id ? `${user.displayName} (you)` : 'Assigned teammate' : 'Unassigned'} icon={<UserRound size={15} />} /><Property label="Created" value={dateLabel(selected.createdAt)} icon={<CalendarDays size={15} />} /><Property label="Last updated" value={dateLabel(selected.updatedAt)} icon={<RefreshCw size={15} />} /><Property label="Approval" value={titleCase(selected.approvalStatus)} icon={<ShieldCheck size={15} />} /><div className="detail-side-foot"><ShieldCheck size={15} /><span>Versioned updates protect against overwriting newer changes.</span></div></div><div className="audit-note"><div className="audit-note-icon"><Activity size={16} /></div><strong>Accountability built in</strong><p>Every committed change has a matching audit event with a sequence number.</p></div></aside></div>
      </>}</section></div>}
  </div>
}

function StatCard({ label, value, detail, icon, tone, loading }: { label: string; value: number; detail: string; icon: ReactNode; tone: string; loading: boolean }) {
  return <div className="stat-card"><div className="stat-top"><span>{label}</span><span className={`stat-icon ${tone}`}>{icon}</span></div><div className="stat-value">{loading ? <span className="skeleton-value" /> : value.toLocaleString('en-IN')}</div><div className="stat-detail"><span className={`detail-dot ${tone}`} />{detail}</div></div>
}
function StatusPill({ value }: { value: string }) { return <span className={`status-pill status-${value}`}><span />{titleCase(value)}</span> }
function PriorityPill({ value }: { value: string }) { return <span className={`priority-pill priority-${value}`}><span className="priority-symbol">{value === 'urgent' ? '↑↑' : value === 'high' ? '↑' : value === 'low' ? '↓' : '–'}</span>{titleCase(value)}</span> }
function Property({ label, value, icon }: { label: string; value: string; icon: ReactNode }) { return <div className="property-row"><div className="property-label">{icon}{label}</div><span>{value}</span></div> }

export default App
