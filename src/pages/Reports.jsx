import { useEffect,useMemo,useState } from 'react'
import { Download, FileSpreadsheet, Search } from 'lucide-react'
import { api } from '../api.js'
import { Button,Card,Empty,Input,PageHeader,Select,Toast } from '../components/UI.jsx'

const reportTypes=[['employees','Employees'],['monthly-attendance','Monthly attendance'],['attendance','Attendance detail'],['leave','Leave'],['holidays','Holidays'],['resignations','Resignations'],['audit','Audit']]
function csvEscape(v){const s=typeof v==='object'&&v!==null?JSON.stringify(v):String(v??'');return /[",\n]/.test(s)?`"${s.replaceAll('"','""')}"`:s}
function downloadCsv(rows,name){if(!rows.length)return;const keys=[...new Set(rows.flatMap(r=>Object.keys(r)))],csv=[keys.join(','),...rows.map(r=>keys.map(k=>csvEscape(r[k])).join(','))].join('\n');const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));a.download=`${name}.csv`;a.click();URL.revokeObjectURL(a.href)}
export default function Reports(){
 const [type,setType]=useState('monthly-attendance'),[month,setMonth]=useState(new Date().toISOString().slice(0,7)),[rows,setRows]=useState([]),[q,setQ]=useState(''),[toast,setToast]=useState('')
 async function load(){try{const r=await api(`/ops/reports?type=${encodeURIComponent(type)}&month=${encodeURIComponent(month)}`);setRows(r.rows||[])}catch(e){setToast(e.message)}} useEffect(()=>{load()},[type,month])
 const shown=useMemo(()=>rows.filter(r=>JSON.stringify(r).toLowerCase().includes(q.toLowerCase())),[rows,q])
 const cols=useMemo(()=>shown.length?Object.keys(shown[0]).slice(0,10):[],[shown])
 return <div className="page"><PageHeader title="Reports" subtitle="Search, review and export HR data" action={<Button onClick={()=>downloadCsv(shown,`${type}-${type==='monthly-attendance'?month:new Date().toISOString().slice(0,10)}`)} disabled={!shown.length}><Download size={16}/> Export CSV</Button>}/><Card><div className="table-tools manager-filters"><Select value={type} onChange={e=>setType(e.target.value)}>{reportTypes.map(([v,l])=><option key={v} value={v}>{l}</option>)}</Select>{type==='monthly-attendance'?<Input type="month" value={month} onChange={e=>setMonth(e.target.value)}/>:null}<div className="search"><Search size={16}/><Input placeholder="Search current report" value={q} onChange={e=>setQ(e.target.value)}/></div></div>{shown.length?<div className="table-wrap"><table><thead><tr>{cols.map(c=><th key={c}>{c.replaceAll('_',' ')}</th>)}</tr></thead><tbody>{shown.slice(0,500).map((r,i)=><tr key={i}>{cols.map(c=><td key={c}>{typeof r[c]==='object'?JSON.stringify(r[c]):String(r[c]??'—')}</td>)}</tr>)}</tbody></table></div>:<Empty><FileSpreadsheet size={24}/> No report rows.</Empty>}</Card><Toast message={toast} onClose={()=>setToast('')}/></div>
}
