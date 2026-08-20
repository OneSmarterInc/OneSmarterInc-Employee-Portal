import { useEffect, useState } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { api } from './api.js'
import Layout from './components/Layout.jsx'
import Login from './pages/Login.jsx'
import Dashboard from './pages/Dashboard.jsx'
import Employees from './pages/Employees.jsx'
import EmployeeDetail from './pages/EmployeeDetail.jsx'
import Attendance from './pages/Attendance.jsx'
import Leave from './pages/Leave.jsx'
import Documents from './pages/Documents.jsx'
import Policies from './pages/Policies.jsx'
import Resignations from './pages/Resignations.jsx'
import Settings from './pages/Settings.jsx'
import Audit from './pages/Audit.jsx'
import Account from './pages/Account.jsx'
import { Loading } from './components/UI.jsx'

export default function App() {
  const [user, setUser] = useState(null)
  const [ready, setReady] = useState(false)
  useEffect(() => { api('/auth/me').then(r => setUser(r.user)).catch(() => setUser(null)).finally(() => setReady(true)) }, [])
  if (!ready) return <Loading />
  if (!user) return <Routes><Route path="/login" element={<Login onLogin={setUser}/>}/><Route path="*" element={<Navigate to="/login" replace/>}/></Routes>
  return <Layout user={user} onLogout={() => setUser(null)}><Routes>
    <Route path="/" element={<Dashboard user={user}/>} />
    <Route path="/attendance" element={<Attendance user={user}/>} />
    <Route path="/leave" element={<Leave user={user}/>} />
    <Route path="/documents" element={<Documents user={user}/>} />
    <Route path="/policies" element={<Policies user={user}/>} />
    <Route path="/resignation" element={<Resignations user={user}/>} />
    <Route path="/account" element={<Account user={user}/>} />
    {user.role === 'MANAGER' ? <>
      <Route path="/employees" element={<Employees/>}/><Route path="/employees/:id" element={<EmployeeDetail/>}/><Route path="/resignations" element={<Resignations user={user}/>}/><Route path="/settings" element={<Settings/>}/><Route path="/audit" element={<Audit/>}/>
    </> : null}
    <Route path="*" element={<Navigate to="/" replace/>}/>
  </Routes></Layout>
}
