import { NavLink, useNavigate } from 'react-router-dom'
import { LayoutDashboard, Users, Clock3, CalendarDays, FileText, LogOut, Settings, ClipboardCheck, DoorOpen, ShieldCheck, UserCog } from 'lucide-react'
import { api } from '../api.js'

const managerNav = [
  ['/','Overview',LayoutDashboard], ['/employees','Employees',Users], ['/attendance','Attendance',Clock3], ['/leave','Leave',CalendarDays],
  ['/documents','Letters',FileText], ['/policies','Policies',ShieldCheck], ['/resignations','Resignations',DoorOpen], ['/audit','Audit',ClipboardCheck], ['/settings','Settings',Settings], ['/account','Account',UserCog],
]
const employeeNav = [
  ['/','Home',LayoutDashboard], ['/attendance','Attendance',Clock3], ['/leave','Leave',CalendarDays], ['/documents','My Letters',FileText], ['/policies','Policies',ShieldCheck], ['/resignation','Resignation',DoorOpen], ['/account','Account',UserCog],
]

export default function Layout({ user, children, onLogout }) {
  const navigate = useNavigate()
  const nav = user.role === 'MANAGER' ? managerNav : employeeNav
  async function logout() { try { await api('/auth/logout', { method: 'POST' }) } finally { onLogout(); navigate('/login') } }
  return <div className="shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark">1S</div><div><strong>One Smarter</strong><span>People Portal</span></div></div>
      <nav>{nav.map(([to,label,Icon]) => <NavLink key={to} to={to} end={to === '/'} className={({isActive}) => isActive ? 'nav-link active' : 'nav-link'}><Icon size={18}/><span>{label}</span></NavLink>)}</nav>
      <div className="sidebar-user"><div className="avatar">{user.name?.[0] || 'U'}</div><div><strong>{user.name}</strong><span>{user.role === 'MANAGER' ? 'Manager' : user.employee?.designation || 'Employee'}</span></div><button onClick={logout} title="Sign out"><LogOut size={17}/></button></div>
    </aside>
    <main className="main"><div className="mobile-top"><span>One Smarter</span></div>{children}</main>
  </div>
}
