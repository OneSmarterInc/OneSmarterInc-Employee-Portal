import { useEffect,useState } from 'react'
import { api,formatDate,formatTime } from '../api.js'
import { Badge, Card, PageHeader } from '../components/UI.jsx'
export default function Audit(){const [rows,setRows]=useState([]);useEffect(()=>{api('/audit').then(r=>setRows(r.logs))},[]);return <div className="page"><PageHeader title="Audit" subtitle="Important portal actions"/><Card><div className="table-wrap"><table><thead><tr><th>When</th><th>Action</th><th>By</th><th>Item</th></tr></thead><tbody>{rows.map(r=><tr key={r.id}><td><strong>{formatDate(r.created_at)}</strong><span>{formatTime(r.created_at)}</span></td><td><Badge tone="neutral">{String(r.action).replaceAll('_',' ')}</Badge></td><td>{r.actor_name||'System'}</td><td>{r.entity_type}</td></tr>)}</tbody></table></div></Card></div>}
