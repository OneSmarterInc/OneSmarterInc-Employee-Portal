import { useEffect,useMemo,useState } from 'react'
import { Bell, CheckCheck, Search } from 'lucide-react'
import { Link } from 'react-router-dom'
import { api,formatDate,formatTime } from '../api.js'
import { Badge,Button,Card,Empty,Input,PageHeader,Toast } from '../components/UI.jsx'

export default function Notifications(){
 const [rows,setRows]=useState([]),[unread,setUnread]=useState(0),[q,setQ]=useState(''),[toast,setToast]=useState('')
 async function load(){try{const r=await api('/ops/notifications');setRows(r.notifications||[]);setUnread(r.unread||0)}catch(e){setToast(e.message)}} useEffect(()=>{load()},[])
 async function read(id){try{await api(`/ops/notifications/${id}`,{method:'PATCH'});load()}catch(e){setToast(e.message)}}
 async function readAll(){try{await api('/ops/notifications/read-all',{method:'PATCH'});setToast('All notifications marked read');load()}catch(e){setToast(e.message)}}
 const shown=useMemo(()=>rows.filter(r=>`${r.title} ${r.message||''}`.toLowerCase().includes(q.toLowerCase())),[rows,q])
 return <div className="page"><PageHeader title="Notifications" subtitle={`${unread} unread`} action={unread?<Button kind="secondary" onClick={readAll}><CheckCheck size={16}/> Mark all read</Button>:null}/><Card><div className="table-tools"><div className="search"><Search size={16}/><Input placeholder="Search notifications" value={q} onChange={e=>setQ(e.target.value)}/></div></div>{shown.length?<div className="notification-list">{shown.map(n=><div className={`notification-row ${n.read_at?'':'unread'}`} key={n.id}><div className="notification-icon"><Bell size={16}/></div><div className="notification-copy"><div><strong>{n.title}</strong>{!n.read_at?<Badge tone="warning">New</Badge>:null}</div><p>{n.message||''}</p><span>{formatDate(n.created_at)} · {formatTime(n.created_at)}</span></div><div className="row-actions">{n.link?<Link className="text-btn" to={n.link} onClick={()=>read(n.id)}>Open</Link>:null}{!n.read_at?<button className="text-btn" onClick={()=>read(n.id)}>Mark read</button>:null}</div></div>)}</div>:<Empty>No notifications.</Empty>}</Card><Toast message={toast} onClose={()=>setToast('')}/></div>
}
