import { X } from 'lucide-react'

export function PageHeader({ title, subtitle, action }) {
  return <div className="page-head"><div><h1>{title}</h1>{subtitle ? <p>{subtitle}</p> : null}</div>{action}</div>
}

export function Card({ children, className = '' }) { return <section className={`card ${className}`}>{children}</section> }
export function Stat({ label, value, hint }) { return <Card className="stat"><span>{label}</span><strong>{value}</strong>{hint ? <small>{hint}</small> : null}</Card> }
export function Badge({ children, tone = 'neutral' }) { return <span className={`badge ${tone}`}>{children}</span> }
export function Empty({ children = 'Nothing here yet.' }) { return <div className="empty">{children}</div> }
export function Loading() { return <div className="loading">Loading…</div> }
export function Button({ children, kind = 'primary', ...props }) { return <button className={`btn ${kind}`} {...props}>{children}</button> }
export function Input(props) { return <input className="input" {...props} /> }
export function Select(props) { return <select className="input" {...props} /> }
export function Textarea(props) { return <textarea className="input textarea" {...props} /> }

export function Modal({ title, children, onClose }) {
  return <div className="modal-backdrop" onMouseDown={onClose}><div className="modal" onMouseDown={e => e.stopPropagation()}>
    <div className="modal-head"><h2>{title}</h2><button className="icon-btn" onClick={onClose} aria-label="Close"><X size={18}/></button></div>
    {children}
  </div></div>
}

export function Toast({ message, type = 'success', onClose }) {
  if (!message) return null
  return <div className={`toast ${type}`} onClick={onClose}>{message}</div>
}
