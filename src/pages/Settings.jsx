import { useEffect,useState } from 'react'
import { MailCheck, Save } from 'lucide-react'
import { api } from '../api.js'
import { Button, Card, Input, PageHeader, Toast } from '../components/UI.jsx'

export default function Settings(){
 const [form,setForm]=useState({host:'',port:587,secure:false,username:'',password:'',from_name:'One Smarter Inc.',from_email:''}),[toast,setToast]=useState('')
 useEffect(()=>{api('/smtp').then(r=>{if(r.smtp)setForm(f=>({...f,...r.smtp,password:''}))})},[])
 async function save(e){e.preventDefault();try{await api('/smtp',{method:'PUT',body:form});setToast('SMTP saved')}catch(e){setToast(e.message)}}
 async function test(){try{const r=await api('/smtp/test',{method:'POST',body:{}});setToast(`Test sent to ${r.email}`)}catch(e){setToast(e.message)}}
 return <div className="page"><PageHeader title="Settings" subtitle="Email delivery"/><Card className="settings-card"><div className="card-title"><h2>SMTP</h2><MailCheck size={18}/></div><form className="form-grid" onSubmit={save}><label>SMTP host<Input value={form.host||''} onChange={e=>setForm({...form,host:e.target.value})} placeholder="smtp.office365.com" required/></label><label>Port<Input type="number" value={form.port||587} onChange={e=>setForm({...form,port:Number(e.target.value)})} required/></label><label>Username<Input value={form.username||''} onChange={e=>setForm({...form,username:e.target.value})} required/></label><label>Password<Input type="password" value={form.password||''} onChange={e=>setForm({...form,password:e.target.value})} placeholder={form.has_password?'Saved — leave blank to keep':''}/></label><label>From name<Input value={form.from_name||''} onChange={e=>setForm({...form,from_name:e.target.value})}/></label><label>From email<Input type="email" value={form.from_email||''} onChange={e=>setForm({...form,from_email:e.target.value})} required/></label><label className="check-row span-2"><input type="checkbox" checked={Boolean(form.secure)} onChange={e=>setForm({...form,secure:e.target.checked})}/> Use secure SSL/TLS connection</label><div className="modal-actions"><Button kind="secondary" type="button" onClick={test}>Send test</Button><Button type="submit"><Save size={16}/> Save SMTP</Button></div></form></Card><Toast message={toast} onClose={()=>setToast('')}/></div>
}
