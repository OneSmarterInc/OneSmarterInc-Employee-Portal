import { useEffect,useState } from 'react'
import { Navigate,Route,Routes } from 'react-router-dom'
import { api } from './api.js'
import Layout from './components/Layout.jsx'
import Login from './pages/Login.jsx'
import Dashboard from './pages/Dashboard.jsx'
import Employees from './pages/Employees.jsx'
import EmployeeDetail from './pages/EmployeeDetail.jsx'
import Attendance from './pages/Attendance.jsx'
import Leave from './pages/Leave.jsx'
import TimeOffRequests from './pages/TimeOffRequests.jsx'
import Documents from './pages/Documents.jsx'
import Policies from './pages/Policies.jsx'
import Compliance from './pages/Compliance.jsx'
import Resignations from './pages/Resignations.jsx'
import Settings from './pages/Settings.jsx'
import Audit from './pages/Audit.jsx'
import Account from './pages/Account.jsx'
import Operations from './pages/Operations.jsx'
import Reports from './pages/Reports.jsx'
import Notifications from './pages/Notifications.jsx'
import { Loading } from './components/UI.jsx'

export default function App(){
 const [user,setUser]=useState(null),[ready,setReady]=useState(false)
 async function refreshUser(){try{const [base,secure]=await Promise.all([api('/auth/me'),api('/security/me')]);setUser({...base.user,...secure.user})}catch{setUser(null)}finally{setReady(true)}}
 useEffect(()=>{refreshUser()},[])
 if(!ready)return <Loading/>
 if(!user)return <Routes><Route path="/login" element={<Login onLogin={u=>{setUser(u);setTimeout(refreshUser,0)}}/>}/><Route path="*" element={<Navigate to="/login" replace/>}/></Routes>
 const access=user.access_role||(user.role==='MANAGER'?'SUPER_ADMIN':'EMPLOYEE'),staff=['SUPER_ADMIN','HR_ADMIN','MANAGER'].includes(access),auditor=access==='AUDITOR'
 if(user.must_change_password)return <Layout user={user} onLogout={()=>setUser(null)}><Routes><Route path="/account" element={<Account user={user} onSecurityChange={refreshUser} forced/>}/><Route path="*" element={<Navigate to="/account" replace/>}/></Routes></Layout>
 if(auditor)return <Layout user={user} onLogout={()=>setUser(null)}><Routes><Route path="/reports" element={<Reports/>}/><Route path="/compliance" element={<Compliance/>}/><Route path="/audit" element={<Audit/>}/><Route path="/notifications" element={<Notifications/>}/><Route path="/account" element={<Account user={user} onSecurityChange={refreshUser}/>}/><Route path="*" element={<Navigate to="/reports" replace/>}/></Routes></Layout>
 return <Layout user={user} onLogout={()=>setUser(null)}><Routes>
  <Route path="/" element={<Dashboard user={user}/>} />
  <Route path="/notifications" element={<Notifications/>}/>
  <Route path="/attendance" element={<Attendance user={user}/>} />
  <Route path="/leave" element={<Leave user={user}/>} />
  <Route path="/requests" element={<TimeOffRequests/>}/>
  <Route path="/documents" element={<Documents user={user}/>} />
  <Route path="/policies" element={<Policies user={user}/>} />
  <Route path="/resignation" element={<Resignations user={user}/>} />
  <Route path="/account" element={<Account user={user} onSecurityChange={refreshUser}/>} />
  {staff?<><Route path="/employees" element={<Employees/>}/><Route path="/employees/:id" element={<EmployeeDetail/>}/><Route path="/resignations" element={<Resignations user={user}/>}/><Route path="/operations" element={<Operations/>}/><Route path="/reports" element={<Reports/>}/><Route path="/compliance" element={<Compliance/>}/><Route path="/settings" element={<Settings/>}/><Route path="/audit" element={<Audit/>}/></>:null}
  <Route path="*" element={<Navigate to="/" replace/>}/>
 </Routes></Layout>
}
