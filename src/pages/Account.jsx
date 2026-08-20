import { useState } from 'react'
import { KeyRound } from 'lucide-react'
import { api } from '../api.js'
import { Button, Card, Input, PageHeader, Toast } from '../components/UI.jsx'

export default function Account({user}){
  const [form,setForm]=useState({current_password:'',new_password:'',confirm:''}),[toast,setToast]=useState('')
  async function submit(e){e.preventDefault();if(form.new_password!==form.confirm)return setToast('New passwords do not match');try{await api('/auth/change-password',{method:'POST',body:{current_password:form.current_password,new_password:form.new_password}});setForm({current_password:'',new_password:'',confirm:''});setToast('Password changed')}catch(e){setToast(e.message)}}
  return <div className="page"><PageHeader title="Account" subtitle={user.email}/><Card className="settings-card"><div className="card-title"><h2>Password</h2><KeyRound size={18}/></div><form className="form-grid" onSubmit={submit}><label>Current password<Input type="password" value={form.current_password} onChange={e=>setForm({...form,current_password:e.target.value})} required/></label><label>New password<Input type="password" minLength="10" value={form.new_password} onChange={e=>setForm({...form,new_password:e.target.value})} required/></label><label>Confirm new password<Input type="password" minLength="10" value={form.confirm} onChange={e=>setForm({...form,confirm:e.target.value})} required/></label><div className="modal-actions"><Button type="submit">Change password</Button></div></form></Card><Toast message={toast} onClose={()=>setToast('')}/></div>
}
