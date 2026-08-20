import { useState } from 'react'
import { ArrowRight, ShieldCheck } from 'lucide-react'
import { api } from '../api.js'
import { Button, Input } from '../components/UI.jsx'
import BrandLogo from '../components/BrandLogo.jsx'

export default function Login({ onLogin }) {
  const [email,setEmail]=useState(''); const [password,setPassword]=useState(''); const [error,setError]=useState(''); const [busy,setBusy]=useState(false)
  async function submit(e){e.preventDefault();setBusy(true);setError('');try{const r=await api('/auth/login',{method:'POST',body:{email,password}});onLogin(r.user)}catch(err){setError(err.message)}finally{setBusy(false)}}
  return <div className="login-page"><div className="login-card">
    <div className="login-brand"><BrandLogo/></div>
    <div className="login-copy"><div className="soft-icon"><ShieldCheck size={22}/></div><h1>People Portal</h1><p>Attendance, leave, documents and employee services in one secure workspace.</p></div>
    <form onSubmit={submit} className="form-stack"><label>Official email<Input type="email" value={email} onChange={e=>setEmail(e.target.value)} autoComplete="email" required/></label><label>Password<Input type="password" value={password} onChange={e=>setPassword(e.target.value)} autoComplete="current-password" required/></label>{error?<div className="form-error">{error}</div>:null}<Button type="submit" disabled={busy}>{busy?'Signing in…':<>Sign in <ArrowRight size={17}/></>}</Button></form>
  </div><div className="login-foot">One Smarter Inc. · Internal People Portal</div></div>
}
