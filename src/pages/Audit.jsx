import { useEffect,useMemo,useState } from 'react'
import { Search } from 'lucide-react'
import { api,formatDate,formatTime } from '../api.js'
import { Badge,Card,Input,PageHeader,Select,Toast } from '../components/UI.jsx'

export default function Audit(){
 const [rows,setRows]=useState([]),[q,setQ]=useState(''),[action,setAction]=useState(''),[entity,setEntity]=useState(''),[from,setFrom]=useState(''),[to,setTo]=useState(''),[toast,setToast]=useState('')
 useEffect(()=>{
  api('/ops/reports?type=audit')
   .then(r=>setRows((r.rows||[]).map((x,i)=>({...x,id:`${x.created_at}-${i}`,actor_name:x.actor}))))
   .catch(e=>setToast(e.message))
 },[])
 const actions=useMemo(()=>[...new Set(rows.map(r=>r.action).filter(Boolean))].sort(),[rows])
 const entities=useMemo(()=>[...new Set(rows.map(r=>r.entity_type).filter(Boolean))].sort(),[rows])
 const shown=useMemo(()=>rows.filter(r=>{const date=String(r.created_at||'').slice(0,10);return(!action||r.action===action)&&(!entity||r.entity_type===entity)&&(!from||date>=from)&&(!to||date<=to)&&`${r.action} ${r.actor_name||''} ${r.entity_type||''} ${r.entity_id||''} ${JSON.stringify(r.details||{})}`.toLowerCase().includes(q.toLowerCase())}),[rows,q,action,entity,from,to])
 return <div className="page"><PageHeader title="Audit" subtitle={`${shown.length} of ${rows.length} portal actions`}/><Card><div className="table-tools manager-filters"><div className="search"><Search size={17}/><Input placeholder="Search action, actor or details" value={q} onChange={e=>setQ(e.target.value)}/></div><Select value={action} onChange={e=>setAction(e.target.value)}><option value="">All actions</option>{actions.map(a=><option key={a} value={a}>{String(a).replaceAll('_',' ')}</option>)}</Select><Select value={entity} onChange={e=>setEntity(e.target.value)}><option value="">All items</option>{entities.map(x=><option key={x} value={x}>{x}</option>)}</Select><Input type="date" value={from} onChange={e=>setFrom(e.target.value)}/><Input type="date" value={to} onChange={e=>setTo(e.target.value)}/></div><div className="table-wrap"><table><thead><tr><th>When</th><th>Action</th><th>By</th><th>Item</th><th>Details</th></tr></thead><tbody>{shown.map(r=><tr key={r.id}><td><strong>{formatDate(r.created_at)}</strong><span>{formatTime(r.created_at)}</span></td><td><Badge tone="neutral">{String(r.action).replaceAll('_',' ')}</Badge></td><td>{r.actor_name||'System'}</td><td>{r.entity_type}<span>{r.entity_id||''}</span></td><td className="audit-details">{Object.entries(r.details||{}).slice(0,4).map(([k,v])=><span key={k}>{String(k).replaceAll('_',' ')}: {String(v)}</span>)}</td></tr>)}</tbody></table></div></Card><Toast message={toast} onClose={()=>setToast('')}/></div>
}
